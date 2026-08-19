// Own-account performance context derived from `post_metrics`.
// Server-only. Callers pass a Supabase client (authenticated user or admin).

type Client = { from: (t: string) => any };

export type MetricRow = {
  buffer_post_id: string;
  text: string;
  service: string | null;
  channel_id: string | null;
  media_type: string | null;
  media_url: string | null;
  impressions: number;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  clicks: number;
  engagement_rate: number;
  sent_at: string | null;
};

const SELECT =
  "buffer_post_id,text,service,channel_id,media_type,media_url,impressions,reach,likes,comments,shares,clicks,engagement_rate,sent_at";

const DAY = 86400000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Everything user-facing assumes Europe/Madrid, but the server runs in UTC —
// bare getHours()/getDay() shifted every timing bucket by the offset (and by
// DST, off-by-one across midnight). Bucket in the brand's timezone instead,
// and say so in the labels.
const TZ = "Europe/Madrid";
const tzHourFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hour: "numeric",
  hour12: false,
});
const tzWeekdayFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long" });
const tzHour = (d: Date) => Number(tzHourFmt.format(d)) % 24; // "24" at midnight → 0
const tzWeekday = (d: Date) => WEEKDAYS.indexOf(tzWeekdayFmt.format(d));

export const channelKey = (r: { service: string | null; channel_id: string | null }) =>
  (r.service ?? r.channel_id ?? "unknown").toLowerCase();

const round = (n: number, d = 2) => Number(n.toFixed(d));
const engagements = (r: MetricRow) => r.likes + r.comments + r.shares + r.clicks;
const excerpt = (t: string, n = 220) => t.replace(/\s+/g, " ").trim().slice(0, n);

/** Loads rows for a workspace, optionally filtered by recency and channel. */
export async function loadMetrics(
  client: Client,
  workspaceId: string,
  opts: { days?: number; channel?: string; limit?: number } = {},
): Promise<MetricRow[]> {
  let q = client
    .from("post_metrics")
    .select(SELECT)
    .eq("workspace_id", workspaceId)
    .order("sent_at", { ascending: false })
    .limit(Math.min(500, opts.limit ?? 300));
  if (opts.days && opts.days > 0) {
    q = q.gte("sent_at", new Date(Date.now() - opts.days * DAY).toISOString());
  }
  const { data, error } = await q;
  if (error || !data) return [];
  const rows = data as MetricRow[];
  const channel = opts.channel?.trim().toLowerCase();
  if (!channel || channel === "all") return rows;
  return rows.filter((r) => channelKey(r) === channel);
}

export type ChannelStats = {
  channel: string;
  posts: number;
  impressions: number;
  reach: number;
  engagements: number;
  avgEngagementRate: number;
  bestEngagementRate: number;
};

export function summarize(rows: MetricRow[]) {
  const byChannel = new Map<string, MetricRow[]>();
  for (const r of rows) {
    const k = channelKey(r);
    const list = byChannel.get(k);
    if (list) list.push(r);
    else byChannel.set(k, [r]);
  }

  const channels: ChannelStats[] = Array.from(byChannel.entries())
    .map(([channel, list]) => ({
      channel,
      posts: list.length,
      impressions: list.reduce((s, r) => s + r.impressions, 0),
      reach: list.reduce((s, r) => s + r.reach, 0),
      engagements: list.reduce((s, r) => s + engagements(r), 0),
      avgEngagementRate: round(list.reduce((s, r) => s + r.engagement_rate, 0) / list.length),
      bestEngagementRate: round(Math.max(...list.map((r) => r.engagement_rate))),
    }))
    .sort((a, b) => b.posts - a.posts);

  return {
    posts: rows.length,
    impressions: rows.reduce((s, r) => s + r.impressions, 0),
    engagements: rows.reduce((s, r) => s + engagements(r), 0),
    avgEngagementRate: rows.length
      ? round(rows.reduce((s, r) => s + r.engagement_rate, 0) / rows.length)
      : 0,
    channels,
    ...timingInsights(rows),
    ...formatInsights(rows),
  };
}

/** Best posting hour / weekday by average engagement rate (needs >= 2 samples). */
function timingInsights(rows: MetricRow[]) {
  const dated = rows.filter((r) => r.sent_at);
  if (dated.length < 4)
    return { bestHour: null as string | null, bestWeekday: null as string | null };
  const agg = (keyFn: (d: Date) => number) => {
    const map = new Map<number, { sum: number; n: number }>();
    for (const r of dated) {
      const k = keyFn(new Date(r.sent_at as string));
      const cur = map.get(k) ?? { sum: 0, n: 0 };
      map.set(k, { sum: cur.sum + r.engagement_rate, n: cur.n + 1 });
    }
    return Array.from(map.entries())
      .filter(([, v]) => v.n >= 2)
      .map(([k, v]) => ({ k, avg: v.sum / v.n, n: v.n }))
      .sort((a, b) => b.avg - a.avg)[0];
  };
  const hour = agg(tzHour);
  const weekday = agg(tzWeekday);
  return {
    bestHour: hour
      ? `${String(hour.k).padStart(2, "0")}:00 ${TZ} (avg ER ${round(hour.avg)}%, ${hour.n} posts)`
      : null,
    bestWeekday: weekday
      ? `${WEEKDAYS[weekday.k]} (${TZ}; avg ER ${round(weekday.avg)}%, ${weekday.n} posts)`
      : null,
  };
}

/** Average engagement rate per media type and per caption-length bucket. */
function formatInsights(rows: MetricRow[]) {
  const bucketOf = (r: MetricRow) => {
    const len = r.text.length;
    if (len < 200) return "short (<200 chars)";
    if (len < 700) return "medium (200-700)";
    return "long (700+)";
  };
  const group = (keyFn: (r: MetricRow) => string) => {
    const map = new Map<string, { sum: number; n: number }>();
    for (const r of rows) {
      const k = keyFn(r);
      const cur = map.get(k) ?? { sum: 0, n: 0 };
      map.set(k, { sum: cur.sum + r.engagement_rate, n: cur.n + 1 });
    }
    return Array.from(map.entries())
      .map(([key, v]) => ({ key, posts: v.n, avgEngagementRate: round(v.sum / v.n) }))
      .sort((a, b) => b.avgEngagementRate - a.avgEngagementRate);
  };
  return {
    byMediaType: group((r) => r.media_type || "text"),
    byLength: group(bucketOf),
  };
}

export function toPostSummary(r: MetricRow) {
  return {
    id: r.buffer_post_id,
    channel: channelKey(r),
    mediaType: r.media_type || "text",
    sentAt: r.sent_at,
    engagementRate: r.engagement_rate,
    impressions: r.impressions,
    likes: r.likes,
    comments: r.comments,
    shares: r.shares,
    text: excerpt(r.text),
  };
}

export function rankPosts(rows: MetricRow[], limit: number, worst: boolean) {
  const sorted = [...rows].sort((a, b) => a.engagement_rate - b.engagement_rate);
  const slice = worst ? sorted.slice(0, limit) : sorted.slice(-limit).reverse();
  return slice.map(toPostSummary);
}

/** Positions a draft against historical averages (length, media, channel). */
export function compareDraft(rows: MetricRow[], draft: string, channel?: string) {
  const scoped =
    channel && channel !== "all" ? rows.filter((r) => channelKey(r) === channel) : rows;
  if (scoped.length === 0) return { enoughData: false as const };
  const s = summarize(scoped);
  const len = draft.trim().length;
  const bucket = len < 200 ? "short (<200 chars)" : len < 700 ? "medium (200-700)" : "long (700+)";
  const bucketStats = s.byLength.find((b) => b.key === bucket) ?? null;
  const best = s.byLength[0] ?? null;
  const withHashtags = /#\w/.test(draft);
  const withQuestion = /\?/.test(draft);
  return {
    enoughData: true as const,
    draftLength: len,
    lengthBucket: bucket,
    lengthBucketAvgEngagementRate: bucketStats?.avgEngagementRate ?? null,
    bestLengthBucket: best ? { bucket: best.key, avgEngagementRate: best.avgEngagementRate } : null,
    accountAvgEngagementRate: s.avgEngagementRate,
    bestMediaType: s.byMediaType[0] ?? null,
    bestHour: s.bestHour,
    bestWeekday: s.bestWeekday,
    draftHasHashtags: withHashtags,
    draftHasQuestion: withQuestion,
    reference: rankPosts(scoped, 3, false),
  };
}

/**
 * Compact digest injected into every chat turn so the agent is grounded in real
 * numbers even when it does not call a tool.
 */
export async function loadPerformanceDigest(
  client: Client,
  workspaceId: string,
  days = 30,
): Promise<string> {
  let rows = await loadMetrics(client, workspaceId, { days });
  let windowLabel = `last ${days} days`;
  if (rows.length === 0) {
    rows = await loadMetrics(client, workspaceId, { limit: 60 });
    windowLabel = "all time (nothing sent in the last 30 days)";
  }
  if (rows.length === 0) {
    return 'PERFORMANCE DATA: none yet. Tell the user to hit "Sync performance" on the Reports page so you can learn from real numbers.';
  }
  const s = summarize(rows);
  const line = (p: ReturnType<typeof toPostSummary>) =>
    `- [${p.channel}/${p.mediaType}] ER ${p.engagementRate}% · ${p.impressions} impressions · ${p.likes}L/${p.comments}C/${p.shares}S — "${p.text.slice(0, 140)}"`;
  const parts = [
    `PERFORMANCE (${windowLabel}, ${s.posts} sent posts, avg ER ${s.avgEngagementRate}%)`,
    `Per channel: ${s.channels.map((c) => `${c.channel} ${c.posts} posts, avg ER ${c.avgEngagementRate}%`).join(" | ")}`,
  ];
  if (s.bestHour) parts.push(`Best hour: ${s.bestHour}. Best weekday: ${s.bestWeekday ?? "n/a"}.`);
  if (s.byMediaType.length)
    parts.push(
      `By format: ${s.byMediaType.map((m) => `${m.key} ${m.avgEngagementRate}%`).join(" | ")}`,
    );
  parts.push(`Top posts:\n${rankPosts(rows, 3, false).map(line).join("\n")}`);
  if (rows.length > 4)
    parts.push(
      `Weakest posts (avoid these patterns):\n${rankPosts(rows, 3, true).map(line).join("\n")}`,
    );
  parts.push(
    "Use these numbers when the user asks what works. For deeper slices call `getPerformanceSummary`, `getTopPosts` or `comparePost`.",
  );
  return parts.join("\n");
}
