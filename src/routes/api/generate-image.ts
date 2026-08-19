import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { playbookBlock } from "@/lib/playbooks.server";
import { requireAuthFromRequest, userClientFromRequest } from "@/lib/require-auth.server";
// Type-only: erased at build time, so the server-only module is never bundled.
import type { Aspect, ImageProviderRow } from "@/lib/image-gen.server";

type Body = {
  prompt: string;
  references?: string[];
  styleNotes?: string;
  workspaceId?: string;
  providerId?: string;
  aspect?: Aspect;
  /**
   * Set true only when the result should deliberately NOT look like the brand's
   * approved work (a one-off, an experiment). Otherwise approved library assets
   * are attached automatically — see loadApprovedReferences.
   */
  ignoreBrandReferences?: boolean;
};

/** How many approved assets to attach when the caller passes none. */
const AUTO_REFERENCE_COUNT = 3;
const DATA_URL = /^data:[^;,]+;base64,/;

const NO_PROVIDER =
  "No image provider connected. Add your own OpenAI, Gemini or Azure image key in Settings → Connections.";

function sseImage(
  b64: string,
  meta?: { referencesUsed?: number; autoAttached?: number },
): Response {
  const body = `event: image_generation.completed\ndata: ${JSON.stringify({ b64_json: b64 })}\n\ndata: [DONE]\n\n`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      // How many references the provider actually ingested, and how many of those
      // the server attached on the caller's behalf. Lets the caller report the
      // truth instead of assuming its own request was honoured.
      "X-References-Used": String(meta?.referencesUsed ?? 0),
      "X-References-Auto-Attached": String(meta?.autoAttached ?? 0),
      "Access-Control-Expose-Headers": "X-References-Used, X-References-Auto-Attached",
    },
  });
}

/**
 * Loads the workspace's approved library assets to use as style references.
 *
 * Approved images outrank the written visual direction. A workspace's approved
 * assets are the work their own designer produced and they signed off on; the
 * guide is only a prose description of that work, and prose drifts. When the two
 * disagree, the images are right — so they are attached by default rather than
 * only when someone remembers to ask.
 *
 * Newest first, on the assumption the most recent approvals reflect the current
 * look. Only base64 data URLs are usable as references.
 */
async function loadApprovedReferences(
  // Structurally typed rather than SupabaseClient<...>: the generated Database
  // types make the concrete client type awkward to name at this call site.
  supabase: { from: (table: string) => any },
  workspaceId: string,
  limit: number,
): Promise<string[]> {
  try {
    const { data, error } = await supabase
      .from("brand_images")
      .select("url,kind,created_at")
      .eq("workspace_id", workspaceId)
      .eq("approved", true)
      .order("created_at", { ascending: false })
      .limit(limit * 3);
    if (error) {
      console.warn("[generate-image] approved-reference lookup failed:", error.message);
      return [];
    }
    return ((data ?? []) as Array<{ url: string | null; kind: string | null }>)
      .filter((r) => r.kind !== "video" && !!r.url && DATA_URL.test(r.url))
      .map((r) => r.url as string)
      .slice(0, limit);
  } catch (e) {
    console.warn(
      "[generate-image] approved-reference lookup threw",
      e instanceof Error ? e.message : e,
    );
    return [];
  }
}

/**
 * Generates through the workspace's own image provider. This is the only path:
 * there is no shared platform account to fall back to.
 */
async function generate(
  request: Request,
  prompt: string,
  references: string[],
  workspaceId?: string,
  providerId?: string,
  aspect?: Aspect,
  autoReferences?: boolean,
): Promise<{ b64: string; referencesUsed?: number; autoAttached?: number } | { error: string }> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  const token = request.headers.get("authorization")?.slice("Bearer ".length).trim();
  if (!url || !key || !token) return { error: "Server misconfigured." };

  let rows: unknown[] | null = null;
  let autoAttached = 0;
  let effectiveRefs = references;
  // The provider row is looked up BEFORE auto-attaching approved references:
  // Azure deployments hard-fail on any reference, so attaching them on the
  // caller's behalf would make the default path un-generatable for an Azure
  // workspace with approved assets. Explicit references still flow through and
  // produce the clear "Azure cannot use references" error — the user asked for
  // something the provider cannot do; the automatic path must not self-destruct.
  try {
    const supabase = createClient(url, key, {
      auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    let q = supabase.from("image_providers").select("*");
    if (providerId) q = q.eq("id", providerId);
    else if (workspaceId) q = q.eq("workspace_id", workspaceId);
    const { data, error } = await q
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) {
      console.error("[generate-image] provider lookup failed:", error.message);
      return { error: "Could not read your image provider settings." };
    }
    rows = data;

    const provider = (rows?.[0] as ImageProviderRow | undefined)?.provider;
    // No explicit references and the caller did not opt out: fall back to the
    // brand's own approved work so "on brand" is the default, not something the
    // agent has to remember to ask for.
    if (effectiveRefs.length === 0 && autoReferences && workspaceId) {
      if (provider === "azure") {
        console.info(
          "[generate-image] skipping auto-attach: references not supported on this provider (azure)",
        );
      } else {
        effectiveRefs = await loadApprovedReferences(supabase, workspaceId, AUTO_REFERENCE_COUNT);
        autoAttached = effectiveRefs.length;
        if (autoAttached)
          console.info(`[generate-image] auto-attached ${autoAttached} approved reference(s)`);
      }
    }
  } catch (e) {
    console.error("[generate-image] provider lookup threw", e instanceof Error ? e.message : e);
    return { error: "Could not read your image provider settings." };
  }

  if (!rows?.length) return { error: NO_PROVIDER };

  const { readProviderKey } = await import("@/lib/crypto.server");
  const { generateWithProvider } = await import("@/lib/image-gen.server");

  const row = rows[0] as ImageProviderRow & { api_key_enc?: string | null };
  // Rows may hold the key encrypted (api_key_enc) or as legacy plaintext.
  const apiKey = await readProviderKey(row);
  if (!apiKey) {
    return {
      error: `"${row.label}" has no usable API key saved. Re-enter it in Settings → Connections.`,
    };
  }

  const res = await generateWithProvider({ ...row, api_key: apiKey }, prompt, effectiveRefs, {
    aspect,
  });
  if (res.b64) return { b64: res.b64, referencesUsed: res.referencesUsed, autoAttached };
  console.error("[generate-image] provider failed:", res.error);
  return { error: res.error ?? "Image generation failed." };
}

export const Route = createFileRoute("/api/generate-image")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await requireAuthFromRequest(request);
        if ("response" in auth) return auth.response;

        const body = (await request.json()) as Body;
        if (!body?.prompt) return new Response("Bad request", { status: 400 });

        // Exact-topic mode: this prompt is fed raw to an image model, so only
        // the image playbook belongs in it. Without `exact` the always-loaded
        // operator manifest and writing rules would be concatenated into the
        // image prompt. Caps: this route IS the image capability.
        const imageRules = await playbookBlock(
          userClientFromRequest(request) as never,
          body.workspaceId ?? null,
          ["image"],
          { image: true },
          { exact: true },
        );
        const autoReferences = body.ignoreBrandReferences !== true;
        const willHaveReferences = (body.references?.length ?? 0) > 0 || autoReferences;

        // Precedence matters here, and it is deliberate.
        //
        // When reference images are attached they are the authority: they are the
        // brand's own approved work, usually made by their designer. The written
        // visual direction is only a prose description of that work, and prose
        // drifts — it is demoted to supporting notes that apply where they do not
        // contradict the images. Getting this the wrong way round is what made
        // generated visuals ignore approved assets.
        //
        // "Avoid text" is deliberately absent: it used to be appended to every
        // prompt and fought brands whose identity is a large typographic headline.
        //
        // The tech-product clause guards against image models drifting toward
        // generic gadget photography when the brand is not a hardware brand.
        const referenceNote = willHaveReferences
          ? "\n\nSOURCE OF TRUTH: the attached reference images. They are this brand's approved work. Replicate their visual language closely — subject matter (including whether people appear, and how they are framed), crop, lighting, colour palette, typographic treatment and overall finish. Where the written notes below disagree with the reference images, the images win. Change only what this prompt explicitly asks to change."
          : "";
        const styleNote = body.styleNotes
          ? `\n\n${willHaveReferences ? "Supporting brand notes (apply only where they do not contradict the reference images)" : "Brand visual direction"}: ${body.styleNotes}`
          : "";
        const fullPrompt = `${body.prompt}${referenceNote}${styleNote}${imageRules ? `\n\n${imageRules}` : ""}\n\nDo NOT include gaming PCs, RGB lighting, computer cases, keyboards, or any tech-product photography unless the prompt explicitly asks for them.`;

        const result = await generate(
          request,
          fullPrompt,
          body.references ?? [],
          body.workspaceId,
          body.providerId,
          body.aspect,
          autoReferences,
        );

        if ("error" in result) {
          // 400 with the real reason: the UI shows this verbatim, so "why did
          // nothing happen" is answerable without opening the server logs.
          return new Response(result.error, { status: 400 });
        }
        return sseImage(result.b64, {
          referencesUsed: result.referencesUsed,
          autoAttached: result.autoAttached,
        });
      },
    },
  },
});
