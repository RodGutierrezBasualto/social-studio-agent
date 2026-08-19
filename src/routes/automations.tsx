import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CronExpressionParser } from "cron-parser";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace } from "@/lib/workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Trash2, Plus, PlayCircle, Bot, HeartPulse, ShieldCheck, Gauge } from "lucide-react";
import { toast } from "sonner";

const DEFAULT_TZ = "Europe/Madrid";
// The cron string is wall-clock in the JOB's zone; the executor honours
// config.timezone, so a Sydney job stays at Sydney wall-clock across DST.
const COMMON_TZS = [
  "Europe/Madrid",
  "Australia/Sydney",
  "Europe/London",
  "America/New_York",
  "America/Los_Angeles",
  "America/Mexico_City",
  "America/Santiago",
  "Asia/Singapore",
  "UTC",
];
function computeNextRun(expression: string, tz = DEFAULT_TZ): Date {
  const it = CronExpressionParser.parse(expression, { currentDate: new Date(), tz });
  return it.next().toDate();
}
/** Formats an ISO instant as wall-clock in the job's own zone, labelled. */
function inZone(iso: string, tz: string): string {
  try {
    return (
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(iso)) + ` (${tz})`
    );
  } catch {
    return new Date(iso).toLocaleString("en-US");
  }
}
function jobTz(j: { config?: Record<string, unknown> | null }): string {
  return (j.config as { timezone?: string } | null)?.timezone || DEFAULT_TZ;
}

export const Route = createFileRoute("/automations")({
  head: () => ({
    meta: [
      { title: "Automations · Social Studio" },
      { name: "description", content: "Autonomous crons that run in the background." },
    ],
  }),
  component: AutomationsPage,
});

type TaskType =
  "daily_post" | "competitor_scan" | "weekly_report" | "metrics_sync" | "performance_reflection";
type Job = {
  id: string;
  workspace_id: string;
  name: string;
  task_type: TaskType;
  schedule: string;
  enabled: boolean;
  config: Record<string, unknown>;
  next_run_at: string | null;
  last_run_at: string | null;
};

const TASK_LABEL: Record<TaskType, string> = {
  daily_post: "Generate & schedule a post",
  competitor_scan: "Review competitors",
  weekly_report: "Weekly performance report",
  metrics_sync: "Sync post performance",
  performance_reflection: "Learn from performance (reflection)",
};

const PRESETS: { label: string; expression: string }[] = [
  { label: "Every day 9:00", expression: "0 9 * * *" },
  { label: "Mon-Fri 8:00", expression: "0 8 * * 1-5" },
  { label: "Every Monday 9:00", expression: "0 9 * * 1" },
  { label: "Every hour", expression: "0 * * * *" },
];

const HEARTBEAT_OPTIONS: { value: string; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "30m", label: "Every 30 minutes" },
  { value: "1h", label: "Every hour" },
  { value: "3h", label: "Every 3 hours" },
  { value: "6h", label: "Every 6 hours" },
  { value: "12h", label: "Every 12 hours" },
  { value: "24h", label: "Once a day" },
];

function AutomationsPage() {
  const { activeWorkspaceId } = useWorkspace();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(false);
  const [autoEnabled, setAutoEnabled] = useState(true);
  const [heartbeat, setHeartbeat] = useState("off");
  const [heartbeatLast, setHeartbeatLast] = useState<string | null>(null);
  const [requireApproval, setRequireApproval] = useState(true);
  const [tokenCap, setTokenCap] = useState("0");
  const [tokensUsed, setTokensUsed] = useState(0);

  // Form state
  const [name, setName] = useState("Daily LinkedIn post");
  const [taskType, setTaskType] = useState<TaskType>("daily_post");
  const [schedule, setSchedule] = useState("0 9 * * *");
  const [timezone, setTimezone] = useState(DEFAULT_TZ);
  const [platform, setPlatform] = useState("linkedin");
  const [brief, setBrief] = useState("Share one practical insight for our audience.");

  const load = async () => {
    if (!activeWorkspaceId) return;
    setLoading(true);
    const { data } = await supabase
      .from("cron_jobs")
      .select("*")
      .eq("workspace_id", activeWorkspaceId)
      .order("created_at", { ascending: false });
    setJobs((data as Job[] | null) ?? []);
    const wsRow = await supabase
      .from("workspaces")
      .select(
        "automations_enabled,heartbeat_interval,heartbeat_last_run_at,require_approval,monthly_token_cap",
      )
      .eq("id", activeWorkspaceId)
      .maybeSingle();
    const ws = wsRow.data as {
      automations_enabled?: boolean;
      heartbeat_interval?: string;
      heartbeat_last_run_at?: string | null;
      require_approval?: boolean;
      monthly_token_cap?: number;
    } | null;
    setAutoEnabled(ws?.automations_enabled ?? true);
    setHeartbeat(ws?.heartbeat_interval ?? "off");
    setHeartbeatLast(ws?.heartbeat_last_run_at ?? null);
    setRequireApproval(ws?.require_approval ?? true);
    setTokenCap(String(ws?.monthly_token_cap ?? 0));

    // Month-to-date AI token spend. Summed in the database (same RPC the cap
    // enforcement uses) so the meter stays honest past the row-fetch limit the
    // old client-side sum silently capped out at.
    // Cast: the generated Database types don't know this function yet.
    const rpc = await (
      supabase.rpc as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => PromiseLike<{ data: unknown; error: { message: string } | null }>
    )("ai_usage_month_total", { ws: activeWorkspaceId });
    if (!rpc.error && rpc.data !== null && rpc.data !== undefined) {
      setTokensUsed(Number(rpc.data) || 0);
    } else {
      // Fallback (e.g. migration not applied yet): the old client-side sum.
      const since = new Date(
        Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
      ).toISOString();
      const usage = await supabase
        .from("activity_log")
        .select("details")
        .eq("workspace_id", activeWorkspaceId)
        .eq("action", "ai.usage")
        .gte("created_at", since)
        .limit(5000);
      const rows = (usage.data as Array<{ details: { totalTokens?: number } | null }> | null) ?? [];
      setTokensUsed(rows.reduce((sum, r) => sum + (Number(r.details?.totalTokens) || 0), 0));
    }
    setLoading(false);
  };
  useEffect(() => {
    void load();
  }, [activeWorkspaceId]); // eslint-disable-line

  const create = async () => {
    if (!activeWorkspaceId) return;
    if (!name.trim() || !schedule.trim()) {
      toast.error("Name and schedule required");
      return;
    }
    const config =
      taskType === "daily_post"
        ? { platform, brief, timezone }
        : taskType === "performance_reflection"
          ? { days: 90, syncFirst: true, timezone }
          : { timezone };
    let nextRunAt: string;
    try {
      nextRunAt = computeNextRun(schedule.trim(), timezone).toISOString();
    } catch {
      toast.error("Invalid cron expression. Use 5 fields (e.g. '0 9 * * *').");
      return;
    }
    const { error } = await supabase.from("cron_jobs").insert({
      workspace_id: activeWorkspaceId,
      name: name.trim(),
      task_type: taskType,
      schedule: schedule.trim(),
      config: config as never,
      next_run_at: nextRunAt,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(`Automation created. Next run: ${inZone(nextRunAt, timezone)}`);
    setName("");
    await load();
  };

  const toggle = async (j: Job) => {
    await supabase.from("cron_jobs").update({ enabled: !j.enabled }).eq("id", j.id);
    await load();
  };
  const remove = async (j: Job) => {
    if (!confirm(`Delete "${j.name}"?`)) return;
    await supabase.from("cron_jobs").delete().eq("id", j.id);
    await load();
  };
  const runNow = async (j: Job) => {
    // Backdating next_run_at only works for enabled jobs — the tick skips
    // disabled ones, so "Run now" on a paused job used to toast success while
    // nothing ever ran. Re-enable it as part of the queueing.
    const wasPaused = !j.enabled;
    const patch: { next_run_at: string; enabled?: boolean } = {
      next_run_at: new Date(Date.now() - 1000).toISOString(),
    };
    if (wasPaused) patch.enabled = true;
    const { error } = await supabase.from("cron_jobs").update(patch).eq("id", j.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    if (!autoEnabled) {
      // Same trap at the workspace level: with the master switch off the tick
      // runs nothing, so a success toast here would be a lie.
      toast.warning(
        `"${j.name}" is queued, but the master switch is off — nothing will run until you turn it on.`,
      );
    } else if (wasPaused) {
      toast.success(
        `"${j.name}" was paused — re-enabled and queued to run on next tick (within 1 minute).`,
      );
    } else {
      toast.success(`"${j.name}" queued to run on next tick (within 1 minute).`);
    }
    await load();
  };
  const toggleGlobal = async (v: boolean) => {
    if (!activeWorkspaceId) return;
    setAutoEnabled(v);
    await supabase
      .from("workspaces")
      .update({ automations_enabled: v })
      .eq("id", activeWorkspaceId);
    toast.success(v ? "Automations resumed" : "All automations paused");
  };
  const saveHeartbeat = async (v: string) => {
    if (!activeWorkspaceId) return;
    setHeartbeat(v);
    const { error } = await supabase
      .from("workspaces")
      .update({ heartbeat_interval: v })
      .eq("id", activeWorkspaceId);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(
      v === "off"
        ? "Heartbeat turned off"
        : `Heartbeat set to ${HEARTBEAT_OPTIONS.find((o) => o.value === v)?.label.toLowerCase()}`,
    );
  };

  const saveApproval = async (v: boolean) => {
    if (!activeWorkspaceId) return;
    setRequireApproval(v);
    const { error } = await supabase
      .from("workspaces")
      .update({ require_approval: v })
      .eq("id", activeWorkspaceId);
    if (error) {
      toast.error(error.message);
      return;
    }
    if (v) {
      toast.success("Autonomous posts will wait for your approval");
      return;
    }
    // Approval turned off — auto-approve everything already waiting in the queue.
    const { data: pending, error: pErr } = await supabase
      .from("scheduled_posts")
      .update({ status: "scheduled" })
      .eq("workspace_id", activeWorkspaceId)
      .eq("status", "pending_approval")
      .select("id");
    if (pErr) {
      toast.error(pErr.message);
      return;
    }
    const n = pending?.length ?? 0;
    toast.success(
      n > 0
        ? `Approval off — ${n} pending post${n === 1 ? "" : "s"} approved automatically`
        : "Approval off — new posts are approved automatically",
    );
  };

  const saveCap = async () => {
    if (!activeWorkspaceId) return;
    const n = Math.max(0, Math.round(Number(tokenCap) || 0));
    const { error } = await supabase
      .from("workspaces")
      .update({ monthly_token_cap: n })
      .eq("id", activeWorkspaceId);
    if (error) {
      toast.error(error.message);
      return;
    }
    setTokenCap(String(n));
    toast.success(
      n === 0 ? "Spend limit removed" : `Monthly limit set to ${n.toLocaleString("en-US")} tokens`,
    );
  };

  const capNumber = Math.max(0, Math.round(Number(tokenCap) || 0));
  const capPct = capNumber > 0 ? Math.min(100, Math.round((tokensUsed / capNumber) * 100)) : 0;

  const weeklyReflectionExists = jobs.some((j) => j.task_type === "performance_reflection");
  const addWeeklyReflection = async () => {
    setName("Weekly performance reflection");
    setTaskType("performance_reflection");
    setSchedule("0 9 * * 1");
    toast.info("Form pre-filled — press Create automation to confirm.");
  };

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="pb-4 border-b border-border flex items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Studio</p>
          <h1 className="mt-1 font-serif text-3xl">Automations</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Cron jobs that run autonomously in the background. Everything they do lands in{" "}
            <span className="italic">Log</span>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="auto-toggle" className="text-xs text-muted-foreground">
            Master switch
          </Label>
          <Switch id="auto-toggle" checked={autoEnabled} onCheckedChange={toggleGlobal} />
        </div>
      </div>

      <section className="mt-6 border border-border rounded-lg p-5 bg-background">
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div className="max-w-xl">
            <h2 className="font-serif text-xl flex items-center gap-2">
              <HeartPulse className="h-4 w-4" /> Agent heartbeat
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              A recurring check-in where the agent reviews upcoming posts, recent failures and
              metric freshness, then writes a short status note to the Log and flags anything that
              needs you. It never publishes on its own.
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              More frequent means faster reaction to problems, but each check-in costs tokens on
              your model key. Hourly or 3-hourly is a good balance; once a day is the cheapest
              useful setting.
            </p>
            {heartbeatLast && (
              <p className="mt-2 text-xs text-muted-foreground">
                Last check-in: {new Date(heartbeatLast).toLocaleString("en-US")}
              </p>
            )}
          </div>
          <div className="min-w-48">
            <Label className="text-xs">Frequency</Label>
            <select
              value={heartbeat}
              onChange={(e) => saveHeartbeat(e.target.value)}
              disabled={!activeWorkspaceId}
              className="mt-1 w-full h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              {HEARTBEAT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <section className="mt-4 border border-border rounded-lg p-5 bg-background">
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div className="max-w-xl">
            <h2 className="font-serif text-xl flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" /> Approval queue
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              When this is on, everything the agent writes on its own lands in{" "}
              <span className="italic">Calendar → Approvals</span> instead of the calendar. You
              review, edit and approve before anything can go out.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="approval-toggle" className="text-xs text-muted-foreground">
              Require approval
            </Label>
            <Switch
              id="approval-toggle"
              checked={requireApproval}
              onCheckedChange={saveApproval}
              disabled={!activeWorkspaceId}
            />
          </div>
        </div>
      </section>

      <section className="mt-4 border border-border rounded-lg p-5 bg-background">
        <h2 className="font-serif text-xl flex items-center gap-2">
          <Gauge className="h-4 w-4" /> Usage cap
        </h2>
        <p className="mt-2 text-sm text-muted-foreground max-w-xl">
          A monthly ceiling on AI tokens across chat, automations, heartbeats and reflections. When
          the cap is hit, autonomous work pauses and the chat replies with a clear message until
          next month or until you raise it. Set 0 for no limit.
        </p>
        <div className="mt-4 flex items-end gap-3 flex-wrap">
          <div>
            <Label className="text-xs">Monthly token cap</Label>
            <Input
              type="number"
              min={0}
              step={10000}
              value={tokenCap}
              onChange={(e) => setTokenCap(e.target.value)}
              className="mt-1 w-48 font-mono"
            />
          </div>
          <Button variant="outline" onClick={saveCap} disabled={!activeWorkspaceId}>
            Save limit
          </Button>
        </div>
        <div className="mt-4">
          <p className="text-xs text-muted-foreground">
            This month:{" "}
            <span className="text-foreground font-medium">
              {tokensUsed.toLocaleString("en-US")}
            </span>{" "}
            tokens
            {capNumber > 0
              ? ` of ${capNumber.toLocaleString("en-US")} (${capPct}%)`
              : " · no limit set"}
          </p>
          {capNumber > 0 && (
            <div className="mt-2 h-1.5 w-full max-w-md rounded bg-muted overflow-hidden">
              <div
                className={`h-full ${capPct >= 100 ? "bg-destructive" : "bg-foreground"}`}
                style={{ width: `${capPct}%` }}
              />
            </div>
          )}
        </div>
      </section>

      {!weeklyReflectionExists && (
        <section className="mt-4 border border-dashed border-border rounded-lg p-4 flex items-center justify-between gap-4 flex-wrap">
          <p className="text-sm text-muted-foreground">
            <span className="text-foreground font-medium">Weekly automatic reflection</span> — every
            Monday the agent syncs post performance, compares winners and losers, and saves what it
            learned to its memory.
          </p>
          <Button size="sm" variant="outline" onClick={addWeeklyReflection}>
            Set it up
          </Button>
        </section>
      )}

      <section className="mt-6 border border-border rounded-lg p-5 space-y-4 bg-muted/30">
        <h2 className="font-serif text-xl flex items-center gap-2">
          <Bot className="h-4 w-4" /> New automation
        </h2>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <Label className="text-xs">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="mt-1" />
          </div>
          <div>
            <Label className="text-xs">Task</Label>
            <select
              value={taskType}
              onChange={(e) => setTaskType(e.target.value as TaskType)}
              className="mt-1 w-full h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              {Object.entries(TASK_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <Label className="text-xs">Schedule (cron, 5 fields)</Label>
            <Input
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              className="mt-1 font-mono"
              placeholder="0 9 * * *"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.expression}
                  onClick={() => setSchedule(p.expression)}
                  className="text-[11px] px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <Label className="text-xs">Timezone</Label>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="mt-1 w-full h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              {COMMON_TZS.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-muted-foreground">
              The cron is wall-clock in this zone — DST is handled for you.
            </p>
          </div>
          {taskType === "daily_post" && (
            <>
              <div>
                <Label className="text-xs">Platform</Label>
                <select
                  value={platform}
                  onChange={(e) => setPlatform(e.target.value)}
                  className="mt-1 w-full h-9 rounded-md border border-border bg-background px-3 text-sm"
                >
                  {["linkedin", "instagram", "tiktok", "x", "facebook"].map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sm:col-span-2">
                <Label className="text-xs">Brief for the agent</Label>
                <Textarea
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                  rows={3}
                  className="mt-1"
                />
              </div>
            </>
          )}
        </div>
        <Button onClick={create} disabled={!activeWorkspaceId}>
          <Plus className="h-4 w-4 mr-2" /> Create automation
        </Button>
      </section>

      <section className="mt-8">
        <h2 className="font-serif text-xl mb-3">Active automations</h2>
        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!loading && jobs.length === 0 && (
          <p className="text-sm text-muted-foreground border border-dashed border-border rounded-lg p-8 text-center">
            No automations yet. Create one above.
          </p>
        )}
        <ul className="space-y-2">
          {jobs.map((j) => (
            <li key={j.id} className="border border-border rounded-lg p-4 flex items-start gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">{j.name}</span>
                  <span className="text-[10px] font-mono uppercase tracking-wider border border-border px-1.5 py-0.5 rounded">
                    {j.task_type}
                  </span>
                  {!j.enabled && (
                    <span className="text-[10px] font-mono uppercase tracking-wider bg-muted px-1.5 py-0.5 rounded">
                      paused
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-1 font-mono">
                  {j.schedule} · {jobTz(j)}
                </p>
                {/* Next run rendered in the JOB's zone, labelled — the browser's
                    locale time for a Sydney job reads like a bug. */}
                <p className="text-xs text-muted-foreground mt-1">
                  Next run: {j.next_run_at ? inZone(j.next_run_at, jobTz(j)) : "—"}
                  {j.last_run_at && <> · Last: {inZone(j.last_run_at, jobTz(j))}</>}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => runNow(j)} title="Run now">
                  <PlayCircle className="h-4 w-4" />
                </Button>
                <Switch checked={j.enabled} onCheckedChange={() => toggle(j)} />
                <Button size="sm" variant="ghost" onClick={() => remove(j)} title="Delete">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
