// Cron executors — run one cron job task and log the result.
// Server-only. Uses the service-role client to bypass RLS since the cron
// tick endpoint is public (secret-authed) and has no user context.

import { generateText, Output } from "ai";
import { z } from "zod";
import { resolveChatModel } from "./llm-resolver.server";
import { playbookBlock } from "./playbooks.server";
import { AGENT_PERSONA, BASE_STYLE_RULES } from "./system-prompts";
import { CronExpressionParser } from "cron-parser";
import { loadBrandBrain } from "./agent-memory.server";
import { logAiUsage } from "./ai-usage.server";
import { reflectOnRun } from "./reflection.server";
import { reflectOnPerformance } from "./performance-reflection.server";
import { loadPerformanceContext, syncBufferMetrics } from "./buffer-analytics.server";
import { assertWithinCap, UsageCapError } from "./usage-caps.server";
import { notify } from "./notifications.server";
import { scanNetwork, type NetworkKey, type NormalizedPost } from "./scrapecreators.server";
import { resolveServiceKey } from "./service-credentials.server";
import { readProviderKey } from "./crypto.server";
import { generateWithProvider, type ImageProviderRow } from "./image-gen.server";
import { publishScheduledPostToBuffer } from "./buffer-publish.server";

type Row = Record<string, unknown>;

// Every field required: strict structured outputs (OpenAI) reject schemas
// where a property is missing from `required`, which .default() would
// produce — the workspace's OpenAI provider was failing every daily_post.
// The prompt already asks for all of these, so requiring them costs nothing.
const PostSchema = z.object({
  platform: z.enum(["linkedin", "instagram", "tiktok", "x", "facebook"]),
  caption: z.string(),
  alternativeHooks: z.array(z.string()),
  shortVersion: z.string(),
  longVersion: z.string(),
  hashtags: z.array(z.string()),
  visualConcept: z.string(),
  cta: z.string(),
  angle: z.string(),
});

type Platform = z.infer<typeof PostSchema>["platform"];

type Job = {
  id: string;
  workspace_id: string;
  name: string;
  task_type:
    "daily_post" | "competitor_scan" | "weekly_report" | "metrics_sync" | "performance_reflection";
  schedule: string;
  enabled: boolean;
  config: Record<string, unknown>;
  next_run_at: string;
};

export function nextFireFromCron(expression: string, tz: string, from = new Date()): Date {
  try {
    const it = CronExpressionParser.parse(expression, { currentDate: from, tz });
    return it.next().toDate();
  } catch {
    // fallback: 1 day later
    return new Date(from.getTime() + 24 * 60 * 60 * 1000);
  }
}

async function loadBrandContext(
  admin: {
    from: (t: string) => {
      select: (s: string) => {
        eq: (c: string, v: string) => { maybeSingle: () => Promise<{ data: Row | null }> };
      };
    };
  },
  workspaceId: string,
): Promise<string> {
  const [{ data: profile }, { data: guide }] = await Promise.all([
    admin.from("brand_profile").select("*").eq("workspace_id", workspaceId).maybeSingle(),
    admin.from("brand_guideline").select("*").eq("workspace_id", workspaceId).maybeSingle(),
  ]);
  const parts: string[] = [];
  if (profile) {
    parts.push(`## Brand profile
Name: ${profile.name ?? ""}
Website: ${profile.website ?? ""}
Industry: ${profile.industry ?? ""}
Audience: ${profile.audience ?? ""}
Products/services: ${profile.products_services ?? ""}
Tone notes: ${profile.tone_notes ?? ""}`);
  }
  if (guide) {
    parts.push(`## Guide
Personality: ${guide.personality ?? ""}
Tone: ${guide.tone_of_voice ?? ""}
Writing style: ${guide.writing_style ?? ""}
Content pillars: ${((guide.content_pillars as string[] | null) ?? []).join(", ")}
Preferred CTAs: ${((guide.preferred_ctas as string[] | null) ?? []).join(", ")}
Visual direction: ${guide.visual_direction ?? ""}
Custom instructions: ${guide.custom_instructions ?? ""}`);
  }
  return parts.join("\n\n") || "(no brand context configured yet)";
}

async function runDailyPost(
  admin: any,
  job: Job,
): Promise<{ summary: string; result: Record<string, unknown> }> {
  const platform = ((job.config.platform as string) || "linkedin") as Platform;
  const brief =
    (job.config.brief as string) ||
    `Write a thoughtful post for today about the brand's current focus area. Educate the audience with one insight and end with a soft CTA.`;
  const hourOffset = Number.isFinite(job.config.hourOffset as number)
    ? Number(job.config.hourOffset)
    : 4;

  const [brandContext, brandBrain, performance] = await Promise.all([
    loadBrandContext(admin, job.workspace_id),
    loadBrandBrain(admin, job.workspace_id),
    loadPerformanceContext(admin, job.workspace_id),
  ]);

  const { model: resolvedModel, modelId: model } = await resolveChatModel(admin, job.workspace_id);
  const playbooks = await playbookBlock(admin, job.workspace_id, ["writing", "buffer"]);
  const started = Date.now();
  const result = await generateText({
    maxOutputTokens: 4096,
    model: resolvedModel,
    system: `${playbooks ? playbooks + "\n\n" : ""}${AGENT_PERSONA}\n\n${BASE_STYLE_RULES}\n\nYou generate ready-to-publish posts. English.`,
    prompt: `Platform: ${platform}
User brief: ${brief}

BRAND CONTEXT:
${brandContext}

${brandBrain}

${performance}

Return a JSON post ready to publish. Concrete, specific, on brand.`,
    output: Output.object({ schema: PostSchema }),
  });

  // Tokens were spent even if the output is unusable — log before parsing.
  await logAiUsage(admin, {
    workspaceId: job.workspace_id,
    model,
    operation: `cron.${job.task_type}`,
    usage: result.usage,
    actorType: "cron",
    durationMs: Date.now() - started,
    relatedType: "cron_job",
    relatedId: job.id,
  });

  // `.output` is a throwing getter in ai@6: it raises at property access when
  // the model stopped for any reason other than "stop" (e.g. truncation) or
  // produced unparseable JSON — so it cannot be destructured off the call.
  let output: z.infer<typeof PostSchema>;
  try {
    output = result.output;
  } catch (e) {
    if (result.finishReason === "length") {
      throw new Error(
        "The model ran out of tokens before finishing the post (finishReason=length). Shorten the brief or raise the token budget.",
      );
    }
    throw new Error(
      `The model returned no valid post JSON (finishReason=${result.finishReason}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // The documented flow is research → draft → visual → schedule, so generate
  // the visual too. It is strictly best-effort: a text-only post is still a
  // post, so any image failure lands in the summary instead of the error path.
  const { imageUrl, imagePath, imageNote } = await generateDailyPostVisual(
    admin,
    job,
    output.visualConcept,
    output.caption,
  );

  const { data: ws } = await admin
    .from("workspaces")
    .select("require_approval")
    .eq("id", job.workspace_id)
    .maybeSingle();
  const requiresApproval =
    (ws as { require_approval?: boolean } | null)?.require_approval !== false;

  const scheduledAt = new Date(Date.now() + hourOffset * 60 * 60 * 1000).toISOString();
  const { data: inserted, error } = await admin
    .from("scheduled_posts")
    .insert({
      workspace_id: job.workspace_id,
      post: output,
      scheduled_at: scheduledAt,
      status: requiresApproval ? "pending_approval" : "scheduled",
      note: `Autopost from cron "${job.name}"`,
      image_url: imageUrl,
      image_storage_path: imagePath,
    })
    .select("id")
    .single();
  if (error) throw new Error(`Insert scheduled_post failed: ${error.message}`);
  const scheduledPostId = (inserted as { id: string }).id;

  if (requiresApproval) {
    await notify(admin, job.workspace_id, "approval", {
      title: "A post is waiting for your approval",
      body: `${platform} · scheduled for ${scheduledAt}\n> ${output.caption.slice(0, 240)}`,
    });
  }

  // Approval off means the user asked for autonomy: hand the freshly created
  // row — and ONLY that row, never pre-existing ones — straight to Buffer.
  let publishNote: string | null = null;
  if (!requiresApproval) {
    const pub = await publishScheduledPostToBuffer(admin, job.workspace_id, {
      id: scheduledPostId,
      platform,
      caption: output.caption,
      imageUrl,
      scheduledAtISO: scheduledAt,
    });
    publishNote = pub.ok
      ? `published to Buffer (${pub.channelName ?? pub.channelId ?? "channel"})${pub.error ? ` — ${pub.error}` : ""}`
      : `internal only: ${pub.error ?? "Buffer publish failed"}`;
  }

  const notes = [imageNote, publishNote].filter(Boolean).join("; ");
  return {
    summary:
      (requiresApproval
        ? `Drafted a ${platform} post for ${scheduledAt} — waiting for your approval.`
        : `Generated & scheduled a ${platform} post for ${scheduledAt}.`) +
      (notes ? ` (${notes})` : ""),
    result: {
      scheduledPostId,
      platform,
      scheduledAt,
      awaitingApproval: requiresApproval,
      caption: output.caption.slice(0, 200),
      ...(imageUrl ? { imageUrl } : {}),
      ...(imageNote ? { imageNote } : {}),
      ...(publishNote ? { publishNote } : {}),
    },
  };
}

/**
 * Generates the daily post's visual with the workspace's default image
 * provider, stores the PNG in the media bucket, and files it in the library
 * (unapproved) so the user can review it. Never throws — failures come back
 * as a note for the run summary.
 */
async function generateDailyPostVisual(
  admin: any,
  job: Job,
  visualConcept: string,
  caption: string,
): Promise<{ imageUrl: string | null; imagePath: string | null; imageNote: string | null }> {
  try {
    const { data: prov } = await admin
      .from("image_providers")
      .select("id,provider,label,api_key,api_key_enc,base_url,default_model")
      .eq("workspace_id", job.workspace_id)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!prov)
      return {
        imageUrl: null,
        imagePath: null,
        imageNote: "no image provider connected — text-only",
      };

    const apiKey = await readProviderKey(prov as { api_key?: string; api_key_enc?: string });
    if (!apiKey)
      return {
        imageUrl: null,
        imagePath: null,
        imageNote: `image provider "${prov.label}" has no usable key — text-only`,
      };
    const providerRow: ImageProviderRow = {
      id: prov.id,
      provider: prov.provider,
      label: prov.label,
      api_key: apiKey,
      base_url: prov.base_url,
      default_model: prov.default_model,
    };

    // Approved brand images are the brand's visual source of truth — pass the
    // newest few as style references. Only data-URLs work as references, and
    // Azure image deployments reject references outright, so skip them there.
    let references: string[] = [];
    if (prov.provider !== "azure") {
      const { data: refs } = await admin
        .from("brand_images")
        .select("url")
        .eq("workspace_id", job.workspace_id)
        .eq("approved", true)
        .eq("kind", "image")
        .like("url", "data:%")
        .order("created_at", { ascending: false })
        .limit(3);
      references = ((refs as { url: string }[] | null) ?? []).map((r) => r.url);
    }

    const { data: guide } = await admin
      .from("brand_guideline")
      .select("visual_direction")
      .eq("workspace_id", job.workspace_id)
      .maybeSingle();
    const visualDirection = (guide as { visual_direction?: string } | null)?.visual_direction ?? "";

    const prompt = `${visualConcept.trim() || `Social media visual for this post: ${caption.slice(0, 400)}`}${visualDirection ? `\n\nBrand visual direction: ${visualDirection}` : ""}`;
    const gen = await generateWithProvider(providerRow, prompt, references, { aspect: "portrait" });
    if (!gen.b64)
      return {
        imageUrl: null,
        imagePath: null,
        imageNote: `image generation failed: ${gen.error ?? "provider returned no image"}`,
      };

    const bytes = Buffer.from(gen.b64, "base64");
    const path = `${job.workspace_id}/daily-${crypto.randomUUID()}.png`;
    const up = await admin.storage
      .from("media")
      .upload(path, bytes, { contentType: "image/png", upsert: false });
    if (up.error)
      return {
        imageUrl: null,
        imagePath: null,
        imageNote: `image upload failed: ${up.error.message}`,
      };
    const signed = await admin.storage.from("media").createSignedUrl(path, 60 * 60 * 24 * 365);
    const signedUrl = signed.data?.signedUrl as string | undefined;
    if (!signedUrl)
      return {
        imageUrl: null,
        imagePath: null,
        imageNote: `image URL signing failed: ${signed.error?.message ?? "unknown"}`,
      };

    // File it in the library unapproved so the user sees (and vets) what the
    // agent produced. The signed URL is stored, not the data URL — a base64
    // PNG would be a megabyte-plus row for no benefit.
    await admin.from("brand_images").insert({
      id: crypto.randomUUID(),
      workspace_id: job.workspace_id,
      url: signedUrl,
      storage_path: path,
      name: `Daily post visual — ${new Date().toISOString().slice(0, 10)}`,
      approved: false,
      kind: "image",
      mime_type: "image/png",
      size_bytes: bytes.length,
    });

    return { imageUrl: signedUrl, imagePath: path, imageNote: null };
  } catch (e) {
    return {
      imageUrl: null,
      imagePath: null,
      imageNote: `image generation failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// Networks a competitor can carry handles for, matching the handles jsonb
// written by the competitors UI ({ instagram?, tiktok?, x?, linkedin? }).
function scanTargets(handles: unknown): { network: NetworkKey; identifier: string }[] {
  const h = (handles ?? {}) as Record<string, unknown>;
  const networks: NetworkKey[] = ["instagram", "tiktok", "x", "linkedin"];
  return networks.flatMap((n) => {
    const v = h[n];
    return typeof v === "string" && v.trim() ? [{ network: n, identifier: v.trim() }] : [];
  });
}

// Per-network stats in the shape the competitor snapshot's `networks` block
// already uses, so a cron refresh slots into the existing analyst profile.
function summarizeScannedPosts(posts: NormalizedPost[]) {
  const engagements = posts
    .map((p) => (p.metrics.likes ?? 0) + (p.metrics.comments ?? 0) + (p.metrics.shares ?? 0))
    .sort((a, b) => a - b);
  const m = Math.floor(engagements.length / 2);
  const median =
    engagements.length === 0
      ? 0
      : engagements.length % 2
        ? engagements[m]
        : Math.round((engagements[m - 1] + engagements[m]) / 2);
  const dates = posts.filter((p) => p.published_at).map((p) => new Date(p.published_at!).getTime());
  let cadencePerWeek: number | undefined;
  if (dates.length >= 2) {
    const spanWeeks = (Math.max(...dates) - Math.min(...dates)) / (1000 * 60 * 60 * 24 * 7);
    cadencePerWeek = spanWeeks > 0 ? Math.round((dates.length / spanWeeks) * 10) / 10 : undefined;
  }
  const formats = posts.reduce<Record<string, number>>((acc, p) => {
    const k = p.media_type ?? "unknown";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  const topFormat = Object.entries(formats).sort((a, b) => b[1] - a[1])[0]?.[0];
  return {
    posts_scanned: posts.length,
    cadence_per_week: cadencePerWeek,
    engagement_median: median,
    top_format: topFormat as string | undefined,
    formats,
  };
}

/**
 * Re-scans every competitor that has per-network handles: fetches their fresh
 * posts via ScrapeCreators, upserts them into social_posts, and refreshes the
 * per-network stats on any existing analyst snapshot. The AI analyst profile
 * itself is only rebuilt from chat (analyzeCompetitor) — that pass is
 * expensive, and the cron's job is keeping the underlying data fresh.
 */
async function runCompetitorScan(
  admin: any,
  job: Job,
): Promise<{ summary: string; result: Record<string, unknown> }> {
  const { data: comps } = await admin
    .from("competitors")
    .select("id,name,handles,snapshot")
    .eq("workspace_id", job.workspace_id);
  const list =
    (comps as
      | { id: string; name: string; handles: unknown; snapshot: Record<string, unknown> | null }[]
      | null) ?? [];
  if (list.length === 0) {
    return {
      summary: "No competitors tracked — nothing to scan.",
      result: { competitors: 0, scanned: 0, skipped: 0 },
    };
  }

  const scKey = await resolveServiceKey(admin, job.workspace_id, "scrapecreators");
  if (!scKey) {
    // No key means no scan happened — say exactly that instead of implying one.
    return {
      summary: `${list.length} competitor${list.length === 1 ? "" : "s"} tracked, but ScrapeCreators is not connected — nothing was scanned. Add a key in Settings → Connections.`,
      result: {
        competitors: list.length,
        scanned: 0,
        skipped: list.length,
        reason: "scrapecreators_not_connected",
      },
    };
  }

  let scanned = 0;
  let skippedNoHandles = 0;
  let postsRefreshed = 0;
  const failures: string[] = [];

  for (const comp of list) {
    const targets = scanTargets(comp.handles);
    if (targets.length === 0) {
      skippedNoHandles++;
      continue;
    }

    const perNetwork: Record<
      string,
      ReturnType<typeof summarizeScannedPosts> & { error?: string }
    > = {};
    const rows: Row[] = [];
    for (const t of targets) {
      try {
        const { posts } = await scanNetwork(t.network, t.identifier, scKey);
        perNetwork[t.network] = summarizeScannedPosts(posts);
        for (const p of posts) {
          rows.push({
            workspace_id: job.workspace_id,
            source: "competitor",
            competitor_id: comp.id,
            network: t.network,
            external_id: p.external_id,
            url: p.url ?? null,
            published_at: p.published_at ?? null,
            caption: p.caption ?? null,
            media_type: p.media_type ?? null,
            metrics: p.metrics,
          });
        }
      } catch (e) {
        console.error("[cron] competitor scan failed", comp.name, t.network, e);
        perNetwork[t.network] = {
          posts_scanned: 0,
          cadence_per_week: undefined,
          engagement_median: 0,
          top_format: undefined,
          formats: {},
          error: e instanceof Error ? e.message : "Scan failed",
        };
      }
    }

    if (rows.length > 0) {
      const { error: upErr } = await admin
        .from("social_posts")
        .upsert(rows, { onConflict: "workspace_id,network,external_id" });
      if (upErr) console.error("[cron] competitor posts upsert failed", upErr);
    }

    // Refresh stats on an existing analyst snapshot only — a stats-only
    // snapshot would render as a broken profile card in the UI.
    if (comp.snapshot) {
      await admin
        .from("competitors")
        .update({ snapshot: { ...comp.snapshot, networks: perNetwork, scannedAt: Date.now() } })
        .eq("id", comp.id);
    }

    if (Object.values(perNetwork).some((s) => !s.error)) {
      scanned++;
      postsRefreshed += rows.length;
    } else {
      const firstError =
        Object.values(perNetwork).find((s) => s.error)?.error ?? "all networks failed";
      failures.push(`${comp.name}: ${firstError}`);
    }
  }

  const parts = [
    `Scanned ${scanned} of ${list.length} competitor${list.length === 1 ? "" : "s"} (${postsRefreshed} posts refreshed).`,
  ];
  if (skippedNoHandles > 0) parts.push(`${skippedNoHandles} skipped (no handles).`);
  if (failures.length > 0) parts.push(`Failed: ${failures.join(" · ")}`.slice(0, 400));
  return {
    summary: parts.join(" "),
    result: {
      competitors: list.length,
      scanned,
      skipped: skippedNoHandles,
      postsRefreshed,
      failures,
    },
  };
}

async function runMetricsSync(
  admin: any,
  job: Job,
): Promise<{ summary: string; result: Record<string, unknown> }> {
  const { data: conn } = await admin
    .from("buffer_connection")
    .select("access_token,access_token_enc")
    .eq("workspace_id", job.workspace_id)
    .maybeSingle();
  const { readBufferToken } = await import("./crypto.server");
  const token = await readBufferToken(
    conn as { access_token?: string; access_token_enc?: string } | null,
  );
  if (!token) throw new Error("Buffer is not connected for this workspace.");
  const limit = Number.isFinite(job.config.limit as number) ? Number(job.config.limit) : 50;
  const res = await syncBufferMetrics(admin, token, job.workspace_id, limit);
  return {
    summary: `Synced performance for ${res.upserted} published post${res.upserted === 1 ? "" : "s"} from Buffer.`,
    result: { fetched: res.fetched, upserted: res.upserted },
  };
}

async function runWeeklyReport(
  admin: any,
  job: Job,
): Promise<{ summary: string; result: Record<string, unknown> }> {
  const now = new Date().toISOString();
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  // Count things that actually happen: rows created, rows handed to Buffer
  // (buffer_id set at publish time) with send times in the window, and metric
  // rows synced back. Nothing ever writes status='published', so counting that
  // status made the digest report 0 forever.
  const [{ count: created }, { count: pushed }, { count: metricsSynced }] = await Promise.all([
    admin
      .from("scheduled_posts")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", job.workspace_id)
      .gte("created_at", since),
    admin
      .from("scheduled_posts")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", job.workspace_id)
      .not("buffer_id", "is", null)
      .gte("scheduled_at", since)
      .lte("scheduled_at", now),
    admin
      .from("post_metrics")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", job.workspace_id)
      .gte("fetched_at", since),
  ]);
  return {
    summary: `Weekly report: ${created ?? 0} posts created, ${pushed ?? 0} sent to Buffer with send times this week, metrics synced for ${metricsSynced ?? 0} published posts in the last 7 days.`,
    result: {
      windowDays: 7,
      created: created ?? 0,
      pushedToBuffer: pushed ?? 0,
      metricsSynced: metricsSynced ?? 0,
    },
  };
}

/**
 * Weekly (or whatever cadence the user picks) review of own-account performance.
 * Optionally refreshes Buffer metrics first so the reflection sees fresh numbers.
 */
async function runPerformanceReflection(
  admin: any,
  job: Job,
): Promise<{ summary: string; result: Record<string, unknown> }> {
  const days = Number.isFinite(job.config.days as number) ? Number(job.config.days) : 90;
  let synced: number | null = null;
  if (job.config.syncFirst !== false) {
    try {
      const { data: conn } = await admin
        .from("buffer_connection")
        .select("access_token,access_token_enc")
        .eq("workspace_id", job.workspace_id)
        .maybeSingle();
      const { readBufferToken } = await import("./crypto.server");
      const token = await readBufferToken(
        conn as { access_token?: string; access_token_enc?: string } | null,
      );
      if (token) synced = (await syncBufferMetrics(admin, token, job.workspace_id, 50)).upserted;
    } catch (e) {
      console.warn("[cron] metrics sync before reflection failed", e);
    }
  }

  const res = await reflectOnPerformance(admin, job.workspace_id, days);
  if (!res.ok) throw new Error(res.reason || "Performance reflection produced nothing.");
  return {
    summary: `Reviewed the last ${days} days of performance and learned ${res.learned} new thing${res.learned === 1 ? "" : "s"}.`,
    result: {
      windowDays: days,
      learned: res.learned,
      synced,
      analysis: (res.summary ?? "").slice(0, 500),
    },
  };
}

export async function runJob(admin: any, job: Job) {
  const startedAt = new Date().toISOString();
  const { data: run } = await admin
    .from("cron_runs")
    .insert({
      job_id: job.id,
      workspace_id: job.workspace_id,
      started_at: startedAt,
      status: "running",
    })
    .select("id")
    .single();
  const runId = (run as { id: string } | null)?.id;

  try {
    // AI-driven tasks respect the workspace monthly token cap.
    if (job.task_type === "daily_post" || job.task_type === "performance_reflection") {
      await assertWithinCap(admin, job.workspace_id);
    }
    let out: { summary: string; result: Record<string, unknown> };
    if (job.task_type === "daily_post") out = await runDailyPost(admin, job);
    else if (job.task_type === "competitor_scan") out = await runCompetitorScan(admin, job);
    else if (job.task_type === "metrics_sync") out = await runMetricsSync(admin, job);
    else if (job.task_type === "weekly_report") out = await runWeeklyReport(admin, job);
    else if (job.task_type === "performance_reflection")
      out = await runPerformanceReflection(admin, job);
    else throw new Error(`Unknown task_type: ${job.task_type}`);

    if (runId)
      await admin
        .from("cron_runs")
        .update({
          status: "ok",
          finished_at: new Date().toISOString(),
          result: out.result,
        })
        .eq("id", runId);

    await admin.from("activity_log").insert({
      workspace_id: job.workspace_id,
      actor_type: "cron",
      action: `cron.${job.task_type}.ok`,
      summary: out.summary,
      status: "ok",
      details: { jobId: job.id, jobName: job.name, ...out.result },
      related_type: "cron_job",
      related_id: job.id,
    });

    if (job.task_type === "performance_reflection" || job.task_type === "weekly_report") {
      await notify(admin, job.workspace_id, "digest", {
        title: "Weekly performance digest",
        body: out.summary,
      });
    }

    // Reflection is an extra LLM pass, so it is reserved for the tasks with
    // something to learn from (content creation, competitive intel) and it
    // respects the same monthly cap as the task itself. Reflecting on plain
    // data plumbing (metrics sync, report counts) or on failures taught the
    // agent nothing and quietly burned tokens.
    let summary = out.summary;
    if (job.task_type === "daily_post" || job.task_type === "competitor_scan") {
      try {
        await assertWithinCap(admin, job.workspace_id);
        await reflectOnRun(admin, {
          workspaceId: job.workspace_id,
          task: `cron: ${job.name} (${job.task_type})`,
          ok: true,
          outcome: out.summary,
          context: out.result,
          relatedType: "cron_job",
          relatedId: job.id,
        });
      } catch (e) {
        if (e instanceof UsageCapError) summary += " (skipped reflection: monthly AI cap reached)";
        else console.warn("[cron] reflection skipped", e);
      }
    }

    return { ok: true as const, summary };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    if (runId)
      await admin
        .from("cron_runs")
        .update({
          status: "error",
          finished_at: new Date().toISOString(),
          error: err,
        })
        .eq("id", runId);
    await admin.from("activity_log").insert({
      workspace_id: job.workspace_id,
      actor_type: "cron",
      action: `cron.${job.task_type}.error`,
      summary: `Cron "${job.name}" failed`,
      status: "error",
      error: err,
      details: { jobId: job.id, jobName: job.name },
      related_type: "cron_job",
      related_id: job.id,
    });
    await notify(admin, job.workspace_id, err.includes("cap reached") ? "cap" : "failure", {
      title: err.includes("cap reached")
        ? "Monthly AI usage cap reached"
        : `Automation failed: ${job.name}`,
      body: err.slice(0, 400),
    });
    return { ok: false as const, error: err };
  }
}

export async function findAndRunDueJobs(admin: any, now = new Date()) {
  // Only jobs in workspaces with automations_enabled
  const { data: jobs } = await admin
    .from("cron_jobs")
    .select("*, workspaces!inner(automations_enabled)")
    .eq("enabled", true)
    .lte("next_run_at", now.toISOString())
    .limit(25);
  const rows = (jobs as (Job & { workspaces: { automations_enabled: boolean } })[] | null) ?? [];
  const runnable = rows.filter((j) => j.workspaces?.automations_enabled !== false);

  const results: { jobId: string; ok: boolean; summary?: string; error?: string }[] = [];
  for (const j of runnable) {
    const res = await runJob(admin, j);
    const tz = (j.config.timezone as string) || "Europe/Madrid";
    const nextAt = nextFireFromCron(j.schedule, tz, now).toISOString();
    await admin
      .from("cron_jobs")
      .update({
        last_run_at: now.toISOString(),
        next_run_at: nextAt,
      })
      .eq("id", j.id);
    results.push({
      jobId: j.id,
      ok: res.ok,
      ...(res.ok ? { summary: res.summary } : { error: res.error }),
    });
  }
  return { checked: rows.length, ran: results.length, results };
}
