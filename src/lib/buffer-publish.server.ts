// Server-side Buffer publishing for automation flows (cron autopost, the
// approve→publish path). The user-facing serverFn in buffer.functions.ts
// carries auth middleware and can't be called without a request context, so
// the GraphQL plumbing is mirrored here for callers that already hold the
// service-role client. Kept deliberately small: one channel, one post.

import { toPublicMediaUrl, assertPubliclyFetchable } from "./public-media.server";

const ENDPOINT = "https://api.buffer.com";

async function gql<T>(
  token: string,
  query: string,
  variables?: Record<string, unknown>,
  op = "graphql",
): Promise<T> {
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
    });
  } catch (e) {
    console.error(`[buffer-publish:${op}] network error`, e);
    throw new Error(`Buffer network error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const ms = Date.now() - startedAt;
  let json: { data?: T; errors?: Array<{ message: string }> } | null = null;
  try {
    json = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok || json?.errors?.length) {
    const msg = json?.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`;
    console.error(`[buffer-publish:${op}] failed in ${ms}ms`, {
      status: res.status,
      errors: json?.errors,
    });
    throw new Error(`Buffer API: ${msg}`);
  }
  console.info(`[buffer-publish:${op}] ok in ${ms}ms`);
  return json!.data as T;
}

// Our post schema says "x"; Buffer's channel list says "twitter". Accept both
// directions so a platform choice never misses its channel over naming.
function serviceMatches(platform: string, service: string): boolean {
  const p = platform.toLowerCase();
  const s = service.toLowerCase();
  if (p === s) return true;
  return (p === "x" && s === "twitter") || (p === "twitter" && s === "x");
}

/**
 * Publishes one scheduled post to the workspace's Buffer channel matching the
 * post's platform. On success the scheduled_posts row is stamped with the
 * Buffer post id + channel id so it is never swept up again.
 *
 * When `ok` is true but `error` is set, the post went out with a caveat
 * (e.g. the image was only reachable locally, so it published text-only) —
 * callers should surface it as a note, not a failure.
 */
export async function publishScheduledPostToBuffer(
  admin: { from: (t: string) => any; storage?: any },
  workspaceId: string,
  post: {
    id: string;
    platform: string;
    caption: string;
    imageUrl?: string | null;
    scheduledAtISO?: string | null;
  },
): Promise<{
  ok: boolean;
  bufferId?: string;
  channelId?: string;
  channelName?: string;
  error?: string;
}> {
  const { data: conn } = await admin
    .from("buffer_connection")
    .select("access_token,access_token_enc,channels")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const { readBufferToken } = await import("./crypto.server");
  const token = await readBufferToken(
    conn as { access_token?: string; access_token_enc?: string } | null,
  );
  if (!token) return { ok: false, error: "Buffer not connected" };

  const channels = Array.isArray((conn as { channels?: unknown }).channels)
    ? (conn as { channels: Array<{ id?: string; name?: string; service?: string }> }).channels
    : [];
  const channel = channels.find(
    (c) => c?.id && serviceMatches(post.platform, String(c.service ?? "")),
  );
  if (!channel?.id) return { ok: false, error: `No ${post.platform} channel linked in Buffer` };

  // Buffer downloads media from its own servers, so a locally-signed URL is
  // useless to it. Rewrite through the public media proxy; if the result is
  // still local-only, drop the image and say so instead of failing the post.
  let imageNote: string | undefined;
  let assets: Array<{ image: { url: string } }> = [];
  if (post.imageUrl) {
    const publicUrl = toPublicMediaUrl(post.imageUrl);
    try {
      assertPubliclyFetchable(publicUrl, "The image");
      assets = [{ image: { url: publicUrl } }];
    } catch (e) {
      imageNote = `image skipped, published text-only: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // customScheduled only accepts future due dates; anything else (past, or no
  // date at all) goes into the next queue slot rather than being rejected.
  const dueAtMs = post.scheduledAtISO ? Date.parse(post.scheduledAtISO) : NaN;
  const isFuture = Number.isFinite(dueAtMs) && dueAtMs > Date.now() + 60_000;
  const mode = isFuture ? "customScheduled" : "addToQueue";

  try {
    type Resp = { createPost: { post?: { id: string; dueAt?: string }; message?: string } };
    const out = await gql<Resp>(
      token,
      `mutation Create($input: CreatePostInput!) {
          createPost(input: $input) {
            ... on PostActionSuccess { post { id dueAt } }
            ... on MutationError { message }
          }
        }`,
      {
        input: {
          channelId: channel.id,
          text: post.caption,
          schedulingType: "automatic",
          mode,
          assets,
          ...(isFuture ? { dueAt: post.scheduledAtISO } : {}),
        },
      },
      "createPost",
    );
    if (!out.createPost.post) {
      return {
        ok: false,
        channelId: channel.id,
        channelName: channel.name,
        error: out.createPost.message ?? "Buffer rejected the post.",
      };
    }
    await admin
      .from("scheduled_posts")
      .update({ buffer_id: out.createPost.post.id, buffer_channel_id: channel.id })
      .eq("id", post.id);
    return {
      ok: true,
      bufferId: out.createPost.post.id,
      channelId: channel.id,
      channelName: channel.name,
      ...(imageNote ? { error: imageNote } : {}),
    };
  } catch (e) {
    return {
      ok: false,
      channelId: channel.id,
      channelName: channel.name,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
