import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { ImageProvider, ImageProviderKind } from "./types";

const wsInput = z.object({ workspaceId: z.string().uuid() });

type Row = {
  id: string;
  workspace_id: string;
  provider: string;
  label: string;
  api_key: string;
  api_key_enc: string | null;
  base_url: string | null;
  default_model: string | null;
  is_default: boolean;
  created_at: string;
};

const rowToProvider = (r: Row): ImageProvider => ({
  id: r.id,
  provider: r.provider as ImageProviderKind,
  label: r.label,
  // Rows written since encryption landed keep api_key blank and store the
  // secret in api_key_enc — either column counts as "has a key".
  hasKey: !!(r.api_key || r.api_key_enc),
  baseUrl: r.base_url ?? undefined,
  defaultModel: r.default_model ?? undefined,
  isDefault: r.is_default,
  createdAt: new Date(r.created_at).getTime(),
});

export const listImageProviders = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { workspaceId: string }) => wsInput.parse(d))
  .handler(async ({ data, context }): Promise<{ providers: ImageProvider[] }> => {
    const { data: rows, error } = await (context.supabase as any)
      .from("image_providers")
      .select("*")
      .eq("workspace_id", data.workspaceId)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { providers: (rows as Row[]).map(rowToProvider) };
  });

export const saveImageProvider = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        workspaceId: z.string().uuid(),
        provider: z.enum(["openai", "gemini", "azure"]),
        label: z.string().min(1).max(100),
        apiKey: z.string().min(8).max(500),
        baseUrl: z.string().url().optional().or(z.literal("")),
        defaultModel: z.string().max(120).optional().or(z.literal("")),
        makeDefault: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<ImageProvider> => {
    const supabase = context.supabase as any;

    const { count } = await supabase
      .from("image_providers")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", data.workspaceId);
    const shouldDefault = data.makeDefault || !count;

    if (shouldDefault) {
      await supabase
        .from("image_providers")
        .update({ is_default: false })
        .eq("workspace_id", data.workspaceId);
    }

    // Encrypt at rest: writeProviderKey stores the secret in api_key_enc and
    // blanks the legacy plaintext column (unless no secret is configured).
    const { writeProviderKey } = await import("./crypto.server");
    const keyCols = await writeProviderKey(data.apiKey);
    const { data: row, error } = await supabase
      .from("image_providers")
      .insert({
        workspace_id: data.workspaceId,
        provider: data.provider,
        label: data.label,
        ...keyCols,
        base_url: data.baseUrl || null,
        default_model: data.defaultModel || null,
        is_default: shouldDefault,
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return rowToProvider(row as Row);
  });

export const setDefaultImageProvider = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: z.string().uuid(), id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const supabase = context.supabase as any;
    await supabase
      .from("image_providers")
      .update({ is_default: false })
      .eq("workspace_id", data.workspaceId);
    const { error } = await supabase
      .from("image_providers")
      .update({ is_default: true })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteImageProvider = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const { error } = await (context.supabase as any)
      .from("image_providers")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const testImageProvider = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<{ ok: boolean; error?: string }> => {
    const { data: row, error } = await (context.supabase as any)
      .from("image_providers")
      .select("*")
      .eq("id", data.id)
      .single();
    if (error || !row) return { ok: false, error: "Provider not found." };
    // The stored key may live encrypted in api_key_enc — resolve it before
    // handing the row to the generator, which reads api_key verbatim.
    const { readProviderKey } = await import("./crypto.server");
    const apiKey = await readProviderKey(row as Row);
    if (!apiKey) return { ok: false, error: "Provider has no usable API key. Re-save it." };
    const { generateWithProvider } = await import("./image-gen.server");
    const res = await generateWithProvider(
      { ...(row as Row), api_key: apiKey },
      "A simple flat-colour circle on a plain background.",
      [],
    );
    return res.b64 ? { ok: true } : { ok: false, error: res.error ?? "Unknown error" };
  });
