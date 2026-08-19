// Approval queue access for the chat agent (server-only).
// Reads and resolves posts sitting in `scheduled_posts` with status
// `pending_approval`. Every write is mirrored into the activity log.

import { logActivity } from "@/lib/activity-log";

type Client = { from: (t: string) => any };

type PostRow = {
  id: string;
  post: { platform?: string; caption?: string; hashtags?: string[] } | null;
  scheduled_at: string | null;
  status: string;
  note: string | null;
  image_url: string | null;
};

const shape = (r: PostRow) => ({
  id: r.id,
  platform: r.post?.platform ?? "unknown",
  caption: (r.post?.caption ?? "").slice(0, 800),
  hashtags: r.post?.hashtags ?? [],
  proposedFor: r.scheduled_at,
  note: r.note,
  hasImage: !!r.image_url,
  status: r.status,
});

export async function listApprovalsForAgent(
  db: Client,
  workspaceId: string,
  args: { status?: "pending" | "rejected" | "all"; limit?: number } = {},
) {
  const status = args.status ?? "pending";
  let q = db
    .from("scheduled_posts")
    .select("id,post,scheduled_at,status,note,image_url")
    .eq("workspace_id", workspaceId)
    .order("scheduled_at", { ascending: true })
    .limit(Math.min(args.limit ?? 20, 50));
  if (status === "pending") q = q.eq("status", "pending_approval");
  else if (status === "rejected") q = q.eq("status", "rejected");
  else q = q.in("status", ["pending_approval", "rejected"]);
  const { data, error } = await q;
  if (error) return { ok: false as const, error: "Could not read the approval queue." };
  const items = ((data ?? []) as PostRow[]).map(shape);
  return { ok: true as const, status, count: items.length, items };
}

async function resolve(
  db: Client,
  workspaceId: string,
  id: string,
  decision: "approve" | "reject",
  caption?: string,
) {
  const { data: row, error: readErr } = await db
    .from("scheduled_posts")
    .select("id,post,scheduled_at,status,image_url")
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (readErr) return { ok: false as const, error: "Could not read that post." };
  if (!row) return { ok: false as const, error: "No post with that id in this workspace." };
  if (row.status !== "pending_approval")
    return { ok: false as const, error: `That post is "${row.status}", not waiting for approval.` };

  const patch: Record<string, unknown> = {
    status: decision === "approve" ? "scheduled" : "rejected",
  };
  if (decision === "approve" && caption?.trim()) {
    patch.post = { ...(row.post ?? {}), caption: caption.trim() };
  }
  const { error } = await db.from("scheduled_posts").update(patch).eq("id", id);
  if (error) return { ok: false as const, error: "Could not update that post." };

  // An approval used to stop at the internal calendar even though the user
  // expects an approved post to actually go out. Attempt the Buffer publish
  // here — with the admin client, because the publish helper needs service-role
  // access for storage and the Buffer token. The approval itself must survive a
  // publish failure: report the outcome, never roll back the status flip.
  let published: { ok: boolean; channelName?: string; error?: string } | null = null;
  if (decision === "approve") {
    try {
      const [{ publishScheduledPostToBuffer }, { supabaseAdmin }] = await Promise.all([
        import("@/lib/buffer-publish.server"),
        import("@/integrations/supabase/client.server"),
      ]);
      const post = (row.post ?? {}) as { platform?: string; caption?: string };
      const res = await publishScheduledPostToBuffer(supabaseAdmin as never, workspaceId, {
        id: row.id,
        platform: post.platform ?? "linkedin",
        caption: caption?.trim() || post.caption || "",
        imageUrl: row.image_url ?? undefined,
        scheduledAtISO: row.scheduled_at ?? undefined,
      });
      published = {
        ok: res.ok,
        channelName: res.channelName ?? undefined,
        error: res.error ?? undefined,
      };
    } catch (e) {
      published = { ok: false, error: e instanceof Error ? e.message : "buffer_publish_failed" };
    }
  }

  await logActivity(
    {
      workspaceId,
      actorType: "agent",
      action: decision === "approve" ? "approval.approved" : "approval.rejected",
      summary:
        decision === "approve"
          ? published?.ok
            ? `Agent approved a pending post and published it to Buffer (${published.channelName ?? "channel"}).`
            : `Agent approved a pending post — approved, but on the internal calendar only: ${published?.error ?? "Buffer publish not available"}.`
          : `Agent rejected a pending post.`,
      relatedType: "scheduled_post",
      relatedId: id,
    },
    db as never,
  );
  if (decision === "approve") {
    return {
      ok: true as const,
      id,
      status: patch.status,
      bufferPublished: published?.ok === true,
      publishNote: published?.ok
        ? `Approved and published to Buffer (${published.channelName ?? "channel"}).`
        : `Approved — the post is on the internal calendar only: ${published?.error ?? "Buffer publish not available"}. Tell the user it is NOT live on social networks.`,
    };
  }
  return { ok: true as const, id, status: patch.status };
}

export const approvePostForAgent = (db: Client, ws: string, id: string, caption?: string) =>
  resolve(db, ws, id, "approve", caption);

export const rejectPostForAgent = (db: Client, ws: string, id: string) =>
  resolve(db, ws, id, "reject");
