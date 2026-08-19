import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useScheduledPosts, scheduleStore } from "@/lib/schedule-store";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace } from "@/lib/workspace";
import { bufferPublishApprovedPost } from "@/lib/buffer.functions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Check, X, ShieldCheck, Trash2 } from "lucide-react";

export const Route = createFileRoute("/approvals")({
  head: () => ({
    meta: [
      { title: "Approvals · Autonomous posts awaiting review" },
      {
        name: "description",
        content:
          "Review, edit and approve the posts your agent drafted autonomously before they go out.",
      },
      { property: "og:title", content: "Approvals · Autonomous posts awaiting review" },
      {
        property: "og:description",
        content:
          "Review, edit and approve the posts your agent drafted autonomously before they go out.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ApprovalsPage,
});

function ApprovalsPage() {
  const posts = useScheduledPosts();
  const { activeWorkspaceId } = useWorkspace();
  const [tab, setTab] = useState<"pending" | "rejected">("pending");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [publishingId, setPublishingId] = useState<string | null>(null);

  const pending = useMemo(() => posts.filter((p) => p.status === "pending_approval"), [posts]);
  const rejected = useMemo(() => posts.filter((p) => p.status === "rejected"), [posts]);
  const list = tab === "pending" ? pending : rejected;

  const approve = async (id: string) => {
    const caption = drafts[id];
    const item = posts.find((p) => p.id === id);
    // Optimistic local flip (also fires the store's own async DB write).
    scheduleStore.update(id, {
      status: "scheduled",
      ...(caption !== undefined && item ? { post: { ...item.post, caption } } : {}),
    });
    if (!activeWorkspaceId) {
      toast.success("Approved — the post is now on the calendar.");
      return;
    }
    setPublishingId(id);
    try {
      // The store's DB write above is fire-and-forget, but the publish server
      // fn refuses anything not persisted as 'scheduled' — so persist the
      // approval with an awaited write before asking the server to publish.
      const { error } = await supabase
        .from("scheduled_posts")
        .update({
          status: "scheduled",
          ...(caption !== undefined && item ? { post: { ...item.post, caption } as never } : {}),
        })
        .eq("id", id);
      if (error) {
        toast.error(`Could not save the approval: ${error.message}`);
        return;
      }

      const res = await bufferPublishApprovedPost({
        data: { workspaceId: activeWorkspaceId, postId: id },
      });
      if (res.ok) {
        toast.success(`Approved and published${res.channelName ? ` (${res.channelName})` : ""}.`);
        void scheduleStore.refresh(); // pick up buffer_id written by the publisher
      } else {
        // The approval stands either way — Buffer trouble must not undo it.
        toast(`Approved — internal calendar only: ${res.error ?? "publishing failed."}`);
      }
    } catch (e) {
      toast(
        `Approved — internal calendar only: ${e instanceof Error ? e.message : "publishing failed."}`,
      );
    } finally {
      setPublishingId(null);
    }
  };
  const reject = (id: string) => {
    scheduleStore.update(id, { status: "rejected" });
    toast("Rejected — kept for reference, not scheduled.");
  };
  const restore = (id: string) => {
    scheduleStore.update(id, { status: "pending_approval" });
  };

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="pb-4 border-b border-border">
        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Studio</p>
        <h1 className="mt-1 font-serif text-3xl flex items-center gap-2">
          <ShieldCheck className="h-6 w-6" /> Approvals
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Posts the agent wrote on its own. Nothing here reaches the calendar or your channels until
          you approve it.
        </p>
      </div>

      <div className="mt-4 flex gap-2">
        {(["pending", "rejected"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`text-xs px-3 py-1.5 rounded border ${tab === t ? "border-foreground text-foreground" : "border-border text-muted-foreground"}`}
          >
            {t === "pending"
              ? `Waiting for you (${pending.length})`
              : `Rejected (${rejected.length})`}
          </button>
        ))}
      </div>

      {list.length === 0 && (
        <p className="mt-6 text-sm text-muted-foreground border border-dashed border-border rounded-lg p-10 text-center">
          {tab === "pending"
            ? "Nothing waiting. The agent has no drafts pending review."
            : "No rejected drafts."}
        </p>
      )}

      <ul className="mt-6 space-y-4">
        {list.map((p) => (
          <li key={p.id} className="border border-border rounded-lg p-4">
            <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
              <Badge variant="outline" className="uppercase">
                {p.post.platform}
              </Badge>
              {p.scheduledAt && (
                <span>Proposed for {new Date(p.scheduledAt).toLocaleString("en-US")}</span>
              )}
              {p.note && <span className="italic">· {p.note}</span>}
            </div>
            <div className="mt-3 flex gap-4">
              {p.imageDataUrl && (
                <img
                  src={p.imageDataUrl}
                  alt={`Visual for the ${p.post.platform} post`}
                  className="w-28 h-28 object-cover rounded border border-border"
                  loading="lazy"
                />
              )}
              <div className="flex-1 min-w-0">
                {tab === "pending" ? (
                  <Textarea
                    rows={6}
                    value={drafts[p.id] ?? p.post.caption}
                    onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                  />
                ) : (
                  <p className="text-sm whitespace-pre-wrap">{p.post.caption}</p>
                )}
                {!!p.post.hashtags?.length && (
                  <p className="mt-2 text-xs text-muted-foreground">{p.post.hashtags.join(" ")}</p>
                )}
              </div>
            </div>
            <div className="mt-3 flex gap-2 justify-end">
              {tab === "pending" ? (
                <>
                  <Button size="sm" variant="outline" onClick={() => reject(p.id)}>
                    <X className="h-4 w-4 mr-1" /> Reject
                  </Button>
                  <Button size="sm" onClick={() => approve(p.id)} disabled={publishingId === p.id}>
                    <Check className="h-4 w-4 mr-1" />{" "}
                    {publishingId === p.id ? "Publishing…" : "Approve & schedule"}
                  </Button>
                </>
              ) : (
                <>
                  <Button size="sm" variant="ghost" onClick={() => scheduleStore.remove(p.id)}>
                    <Trash2 className="h-4 w-4 mr-1" /> Delete
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => restore(p.id)}>
                    Move back to pending
                  </Button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
