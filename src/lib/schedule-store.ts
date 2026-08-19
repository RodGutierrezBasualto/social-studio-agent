// Schedule store — Supabase-backed per workspace, sync read API for components.
import { useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { logActivityFn } from "./activity-log";
import type { GeneratedPost } from "./types";

export type ScheduleStatus = "draft" | "scheduled" | "published" | "pending_approval" | "rejected";

export type ScheduledPost = {
  id: string;
  post: GeneratedPost;
  imageDataUrl?: string;
  videoUrl?: string;
  scheduledAt: number | null;
  status: ScheduleStatus;
  note?: string;
  createdAt: number;
  bufferId?: string;
  bufferChannelId?: string;
};

type Listener = () => void;
const listeners = new Set<Listener>();
let workspaceId: string | null = null;
let cache: ScheduledPost[] = [];
let hydratedForWorkspace: string | null = null;
let inflight: Promise<void> | null = null;
const EMPTY: ScheduledPost[] = [];

const emit = () => listeners.forEach((l) => l());

type Row = {
  id: string;
  workspace_id: string;
  post: GeneratedPost;
  image_url: string | null;
  video_url: string | null;
  scheduled_at: string | null;
  status: string;
  note: string | null;
  buffer_id: string | null;
  buffer_channel_id: string | null;
  created_at: string;
};
const rowToPost = (r: Row): ScheduledPost => ({
  id: r.id,
  post: r.post,
  imageDataUrl: r.image_url ?? undefined,
  videoUrl: r.video_url ?? undefined,
  scheduledAt: r.scheduled_at ? new Date(r.scheduled_at).getTime() : null,
  status: (r.status as ScheduleStatus) ?? "draft",
  note: r.note ?? undefined,
  createdAt: new Date(r.created_at).getTime(),
  bufferId: r.buffer_id ?? undefined,
  bufferChannelId: r.buffer_channel_id ?? undefined,
});

async function hydrate(force = false) {
  if (!workspaceId) return;
  if (!force && hydratedForWorkspace === workspaceId) return;
  if (inflight) return inflight;
  const ws = workspaceId;
  inflight = (async () => {
    try {
      const { data, error } = await supabase
        .from("scheduled_posts")
        .select("*")
        .eq("workspace_id", ws)
        .order("created_at", { ascending: false });
      if (workspaceId !== ws) return;
      if (error) {
        // Transient (e.g. statement timeout) — don't mark hydrated so we retry.
        console.error("[schedule] hydrate failed", error);
        return;
      }
      cache = (data as unknown as Row[]).map(rowToPost);
      hydratedForWorkspace = ws;
      emit();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export const scheduleStore = {
  setWorkspace(id: string | null) {
    if (id === workspaceId) return;
    workspaceId = id;
    hydratedForWorkspace = null;
    cache = [];
    emit();
    if (id) void hydrate();
  },
  subscribe(l: Listener) {
    void hydrate();
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  refresh: () => hydrate(true),
  getAll(): ScheduledPost[] {
    return cache;
  },
  // add/update/remove resolve AFTER the DB write so callers (the chat tool
  // handlers above all) can report the real outcome instead of an optimistic
  // ok. They resolve — never reject — with { ok } so legacy fire-and-forget
  // call sites cannot leak unhandled rejections; on failure the optimistic
  // cache change is reverted and a toast still fires.
  async add(
    item: Omit<ScheduledPost, "id" | "createdAt"> & { id?: string },
  ): Promise<{ ok: boolean; error?: string; post: ScheduledPost }> {
    const full: ScheduledPost = {
      id: item.id ?? crypto.randomUUID(),
      createdAt: Date.now(),
      ...item,
    } as ScheduledPost;
    cache = [full, ...cache];
    emit();
    if (!workspaceId) return { ok: true, post: full };
    const ws = workspaceId;
    const { error } = await supabase.from("scheduled_posts").insert({
      id: full.id,
      workspace_id: ws,
      post: full.post as unknown as never,
      image_url: full.imageDataUrl ?? null,
      video_url: full.videoUrl ?? null,
      scheduled_at: full.scheduledAt ? new Date(full.scheduledAt).toISOString() : null,
      status: full.status,
      note: full.note ?? null,
      buffer_id: full.bufferId ?? null,
      buffer_channel_id: full.bufferChannelId ?? null,
    });
    if (error) {
      console.error("[schedule] add failed", error);
      toast.error("Could not save post");
      cache = cache.filter((p) => p.id !== full.id);
      emit();
      return { ok: false, error: error.message, post: full };
    }
    const when = full.scheduledAt ? new Date(full.scheduledAt).toLocaleString("en-US") : "draft";
    logActivityFn({
      workspaceId: ws,
      action: full.bufferId ? "buffer.published" : "post.scheduled",
      summary: `${full.bufferId ? "Published on Buffer" : "Scheduled"} ${full.post.platform} post for ${when}: "${full.post.caption.slice(0, 80)}"`,
      details: {
        platform: full.post.platform,
        hasImage: !!full.imageDataUrl,
        hasVideo: !!full.videoUrl,
        bufferId: full.bufferId ?? null,
      },
      relatedType: "scheduled_post",
      relatedId: full.id,
    });
    return { ok: true, post: full };
  },
  async update(
    id: string,
    patch: Partial<ScheduledPost>,
  ): Promise<{ ok: boolean; error?: string }> {
    const before = cache.find((p) => p.id === id);
    cache = cache.map((p) => (p.id === id ? { ...p, ...patch } : p));
    emit();
    if (!workspaceId) return { ok: true };
    const ws = workspaceId;
    type PostUpdate = {
      post?: unknown;
      image_url?: string | null;
      video_url?: string | null;
      scheduled_at?: string | null;
      status?: string;
      note?: string | null;
      buffer_id?: string | null;
      buffer_channel_id?: string | null;
    };
    const dbPatch: PostUpdate = {};
    if (patch.post !== undefined) dbPatch.post = patch.post;
    if (patch.imageDataUrl !== undefined) dbPatch.image_url = patch.imageDataUrl ?? null;
    if (patch.videoUrl !== undefined) dbPatch.video_url = patch.videoUrl ?? null;
    if (patch.scheduledAt !== undefined)
      dbPatch.scheduled_at = patch.scheduledAt ? new Date(patch.scheduledAt).toISOString() : null;
    if (patch.status !== undefined) dbPatch.status = patch.status;
    if (patch.note !== undefined) dbPatch.note = patch.note ?? null;
    if (patch.bufferId !== undefined) dbPatch.buffer_id = patch.bufferId ?? null;
    if (patch.bufferChannelId !== undefined)
      dbPatch.buffer_channel_id = patch.bufferChannelId ?? null;
    if (Object.keys(dbPatch).length === 0) return { ok: true };
    const { error } = await supabase
      .from("scheduled_posts")
      .update(dbPatch as never)
      .eq("id", id);
    if (error) {
      console.error("[schedule] update failed", error);
      toast.error("Could not update post");
      if (before) {
        cache = cache.map((p) => (p.id === id ? before : p));
        emit();
      }
      return { ok: false, error: error.message };
    }
    if (patch.scheduledAt !== undefined) {
      const when = patch.scheduledAt
        ? new Date(patch.scheduledAt).toLocaleString("en-US")
        : "drafts";
      logActivityFn({
        workspaceId: ws,
        action: "post.rescheduled",
        summary: `Moved post to ${when}.`,
        relatedType: "scheduled_post",
        relatedId: id,
      });
    }
    return { ok: true };
  },
  async remove(id: string): Promise<{ ok: boolean; error?: string }> {
    const existing = cache.find((p) => p.id === id);
    cache = cache.filter((p) => p.id !== id);
    emit();
    const ws = workspaceId;
    const { error } = await supabase.from("scheduled_posts").delete().eq("id", id);
    if (error) {
      console.error("[schedule] remove failed", error);
      toast.error("Could not delete post");
      if (existing) {
        cache = [existing, ...cache];
        emit();
      }
      return { ok: false, error: error.message };
    }
    if (ws && existing) {
      logActivityFn({
        workspaceId: ws,
        action: "post.deleted",
        summary: `Deleted ${existing.post.platform} post: "${existing.post.caption.slice(0, 80)}"`,
        relatedType: "scheduled_post",
        relatedId: id,
      });
    }
    return { ok: true };
  },
  reschedule(id: string, newDate: number | null) {
    return this.update(id, { scheduledAt: newDate, status: newDate ? "scheduled" : "draft" });
  },
};

function useHydrated() {
  const [h, setH] = useState(false);
  useEffect(() => setH(true), []);
  return h;
}

export function useScheduledPosts() {
  const h = useHydrated();
  const v = useSyncExternalStore(
    scheduleStore.subscribe,
    () => cache,
    () => EMPTY,
  );
  return h ? v : EMPTY;
}
