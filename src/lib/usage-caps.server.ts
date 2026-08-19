// Monthly AI usage caps.
// Token spend is already recorded in activity_log (action = 'ai.usage') by
// logAiUsage, so the cap is derived from that same source — no extra table.
// A cap of 0 means unlimited.

type Client = {
  from: (t: string) => any;
  rpc?: (fn: string, args?: Record<string, unknown>) => any;
};

export class UsageCapError extends Error {
  used: number;
  cap: number;
  constructor(used: number, cap: number) {
    super(
      `Monthly AI usage cap reached (${used.toLocaleString("en-US")} / ${cap.toLocaleString("en-US")} tokens). ` +
        `Raise or remove the cap in the Automations page (/automations).`,
    );
    this.name = "UsageCapError";
    this.used = used;
    this.cap = cap;
  }
}

export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export type UsageSnapshot = {
  used: number;
  cap: number;
  exceeded: boolean;
  remaining: number | null;
  periodStart: string;
};

export async function getMonthlyUsage(client: Client, workspaceId: string): Promise<UsageSnapshot> {
  const since = monthStart().toISOString();
  const { data: ws } = await client
    .from("workspaces")
    .select("monthly_token_cap")
    .eq("id", workspaceId)
    .maybeSingle();
  const cap = Number((ws as { monthly_token_cap?: number } | null)?.monthly_token_cap ?? 0) || 0;

  // Sum in the database. The old approach fetched up to 5000 activity_log rows
  // and summed client-side — busy months past that limit silently under-counted
  // and stopped enforcing the cap.
  let used: number | null = null;
  if (typeof client.rpc === "function") {
    const { data, error } = await client.rpc("ai_usage_month_total", { ws: workspaceId });
    if (!error && data !== null && data !== undefined) used = Number(data) || 0;
  }

  if (used === null) {
    // Fallback (RPC missing or errored, e.g. migration not applied yet):
    // the legacy row-fetch sum, with its known 5000-row ceiling.
    const { data: rows } = await client
      .from("activity_log")
      .select("details")
      .eq("workspace_id", workspaceId)
      .eq("action", "ai.usage")
      .gte("created_at", since)
      .limit(5000);
    used = ((rows ?? []) as Array<{ details: { totalTokens?: number } | null }>).reduce(
      (sum, r) => sum + (Number(r.details?.totalTokens) || 0),
      0,
    );
  }

  return {
    used,
    cap,
    exceeded: cap > 0 && used >= cap,
    remaining: cap > 0 ? Math.max(0, cap - used) : null,
    periodStart: since,
  };
}

/** Throws UsageCapError when the workspace is over its monthly token cap. */
export async function assertWithinCap(client: Client, workspaceId: string): Promise<void> {
  let snap: UsageSnapshot;
  try {
    snap = await getMonthlyUsage(client, workspaceId);
  } catch (e) {
    // Never block work because the meter itself failed.
    console.warn("[usage-caps] check failed", e instanceof Error ? e.message : e);
    return;
  }
  if (snap.exceeded) throw new UsageCapError(snap.used, snap.cap);
}
