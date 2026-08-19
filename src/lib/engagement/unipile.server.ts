// Unipile adapter — the first EngagementProvider.
// Covers comments on our own posts, mentions, DMs (chats), reactions and the
// hosted account-linking flow. Server-only.
//
// Credentials live in `service_credentials` with service = 'unipile':
//   api_key_enc -> the Unipile API key (encrypted)
//   label       -> the account DSN, e.g. "api8.unipile.com:13843"

import { readProviderKey } from "../crypto.server";

type Client = { from: (t: string) => any };

export type UnipileCreds = { dsn: string; apiKey: string };

export class UnipileNotConnectedError extends Error {
  constructor() {
    super("Unipile is not connected. Add your Unipile API key and DSN in Settings → Connections.");
    this.name = "UnipileNotConnectedError";
  }
}

export async function loadUnipileCreds(
  client: Client,
  workspaceId: string,
): Promise<UnipileCreds | null> {
  const { data } = await client
    .from("service_credentials")
    .select("api_key,api_key_enc,label")
    .eq("workspace_id", workspaceId)
    .eq("service", "unipile")
    .maybeSingle();
  if (!data) return null;
  const apiKey = await readProviderKey(data as { api_key?: string; api_key_enc?: string });
  const dsn = String((data as { label?: string }).label ?? "").trim();
  if (!apiKey || !dsn) return null;
  return { dsn: normalizeDsn(dsn), apiKey };
}

export async function requireUnipileCreds(
  client: Client,
  workspaceId: string,
): Promise<UnipileCreds> {
  const creds = await loadUnipileCreds(client, workspaceId);
  if (!creds) throw new UnipileNotConnectedError();
  return creds;
}

export function normalizeDsn(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

async function call<T>(
  creds: UnipileCreds,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    query?: Record<string, string | number | undefined>;
  } = {},
): Promise<T> {
  const url = new URL(`https://${creds.dsn}/api/v1${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: init.method ?? "GET",
      headers: {
        "X-API-KEY": creds.apiKey,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (e) {
    throw new Error(`Unipile network error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    console.error(`[unipile] ${init.method ?? "GET"} ${path} -> ${res.status}`, text.slice(0, 400));
    throw new Error(`Unipile request failed (${res.status}): ${text.slice(0, 200) || "no body"}`);
  }
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    return {} as T;
  }
}

// ---------------------------------------------------------------- accounts

export type UnipileAccount = {
  id: string;
  type: string;
  name: string;
  status: string;
};

// LinkedIn text arrives with astral-plane characters (emoji, 𝗯𝗼𝗹𝗱 unicode).
// An unpaired UTF-16 surrogate anywhere in a row makes Postgres reject the
// whole insert payload as invalid JSON, so strip lone halves at the source.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const str = (v: unknown): string =>
  (typeof v === "string" ? v : v == null ? "" : String(v)).replace(LONE_SURROGATE, "");

export async function listAccounts(creds: UnipileCreds): Promise<UnipileAccount[]> {
  const out = await call<{ items?: unknown[] }>(creds, "/accounts", { query: { limit: 100 } });
  return (out.items ?? []).map((raw) => {
    const a = raw as Record<string, unknown>;
    const sources = (a.sources as Array<Record<string, unknown>> | undefined) ?? [];
    return {
      id: str(a.id),
      type: str(a.type || a.provider).toUpperCase(),
      name: str(a.name || (a.connection_params as Record<string, unknown>)?.["mail"] || a.id),
      status: str(sources[0]?.["status"] ?? "OK").toUpperCase(),
    };
  });
}

export async function deleteAccount(creds: UnipileCreds, accountId: string): Promise<void> {
  await call(creds, `/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
}

/** Creates a hosted auth link so the user connects their own account. */
export async function createHostedAuthLink(
  creds: UnipileCreds,
  opts: {
    successRedirectUrl: string;
    failureRedirectUrl: string;
    notifyUrl?: string;
    name: string;
  },
): Promise<string> {
  const expiresOn = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const out = await call<{ url?: string }>(creds, "/hosted/accounts/link", {
    method: "POST",
    body: {
      type: "create",
      providers: "*",
      api_url: `https://${creds.dsn}`,
      expiresOn,
      name: opts.name,
      success_redirect_url: opts.successRedirectUrl,
      failure_redirect_url: opts.failureRedirectUrl,
      ...(opts.notifyUrl ? { notify_url: opts.notifyUrl } : {}),
    },
  });
  if (!out.url) throw new Error("Unipile did not return a hosted auth URL.");
  return out.url;
}

// ------------------------------------------------------------------- posts

export type UnipilePost = {
  id: string;
  text: string;
  url: string | null;
  postedAt: string | null;
  commentCount: number;
};

function pickDate(a: Record<string, unknown>): string | null {
  const raw = a.date ?? a.parsed_datetime ?? a.timestamp ?? a.created_at;
  if (!raw) return null;
  const d = typeof raw === "number" ? new Date(raw) : new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function listOwnPosts(
  creds: UnipileCreds,
  accountId: string,
  identifier: string,
  limit = 15,
): Promise<UnipilePost[]> {
  const out = await call<{ items?: unknown[] }>(
    creds,
    `/users/${encodeURIComponent(identifier)}/posts`,
    { query: { account_id: accountId, limit } },
  );
  return (out.items ?? []).map((raw) => {
    const p = raw as Record<string, unknown>;
    return {
      // The comments endpoint 400s on the numeric id but accepts the URN in
      // social_id ("urn:li:activity:…") — verified against the live API.
      id: str(p.social_id || p.id || p.share_url),
      text: str(p.text || p.commentary).slice(0, 400),
      url: str(p.share_url || p.permalink) || null,
      postedAt: pickDate(p),
      commentCount: Number(p.comment_counter ?? p.comments_count ?? 0) || 0,
    };
  });
}

export type UnipilePostDetail = {
  postId: string;
  text: string;
  authorName: string;
  authorHeadline: string | null;
  shareUrl: string | null;
  postedAt: string | null;
  reactions: number;
  comments: number;
  reposts: number;
  impressions: number | null;
  mediaKinds: string[];
};

/** Fetch a single (public or authorized) post by the id parsed from its URL. */
export async function getPost(
  creds: UnipileCreds,
  accountId: string,
  postId: string,
): Promise<UnipilePostDetail> {
  const p = await call<Record<string, any>>(creds, `/posts/${encodeURIComponent(postId)}`, {
    query: { account_id: accountId },
  });
  const author = (p.author ?? {}) as Record<string, unknown>;
  const attachments = Array.isArray(p.attachments) ? p.attachments : [];
  return {
    postId: str(p.social_id || p.id || postId),
    text: str(p.text || p.commentary || p.caption),
    authorName: str(author.name || author.display_name || p.author_name) || "Unknown author",
    authorHeadline: str(author.headline) || null,
    shareUrl: str(p.share_url || p.permalink) || null,
    postedAt: pickDate(p),
    reactions: Number(p.reaction_counter ?? p.like_count ?? 0) || 0,
    comments: Number(p.comment_counter ?? p.comments_count ?? 0) || 0,
    reposts: Number(p.repost_counter ?? 0) || 0,
    impressions: p.impressions_counter != null ? Number(p.impressions_counter) || 0 : null,
    mediaKinds: [...new Set(attachments.map((a: any) => str(a?.type)).filter(Boolean))] as string[],
  };
}

/** The identity behind a connected account (used to list our own posts). */
export async function getOwnProfile(
  creds: UnipileCreds,
  accountId: string,
): Promise<{ id: string; name: string; publicIdentifier: string | null }> {
  const out = await call<Record<string, unknown>>(creds, "/users/me", {
    query: { account_id: accountId },
  });
  return {
    id: str(out.provider_id || out.id),
    name: str(out.display_name || out.name || out.first_name),
    publicIdentifier: str(out.public_identifier) || null,
  };
}

export type UnipileComment = {
  id: string;
  text: string;
  authorName: string;
  authorId: string | null;
  authorUrl: string | null;
  authorAvatarUrl: string | null;
  createdAt: string | null;
  isOwn: boolean;
};

export async function listPostComments(
  creds: UnipileCreds,
  accountId: string,
  postId: string,
  limit = 30,
  ownProviderId?: string,
): Promise<UnipileComment[]> {
  const out = await call<{ items?: unknown[] }>(
    creds,
    `/posts/${encodeURIComponent(postId)}/comments`,
    { query: { account_id: accountId, limit } },
  );
  return (out.items ?? []).map((raw) => {
    const c = raw as Record<string, unknown>;
    // Live shape: `author` is the display name as a plain string, and the ids,
    // urls and avatar live in `author_details`. Keep object fallbacks in case
    // other networks differ.
    const author = (typeof c.author === "object" && c.author ? c.author : {}) as Record<
      string,
      unknown
    >;
    const details = (c.author_details as Record<string, unknown> | undefined) ?? {};
    const authorId =
      str(details.id || author.id || author.public_identifier || c.author_id) || null;
    return {
      id: str(c.id || c.comment_id),
      text: str(c.text || c.body),
      authorName:
        typeof c.author === "string"
          ? str(c.author)
          : str(author.name || author.display_name || c.author_name),
      authorId,
      authorUrl:
        str(
          details.profile_url || author.profile_url || author.public_profile_url || c.author_url,
        ) || null,
      authorAvatarUrl:
        str(details.profile_picture_url || author.profile_picture_url || author.picture_url) ||
        null,
      createdAt: pickDate(c),
      // There is no is_own flag in the live payload — our own replies are
      // recognised by author id instead, so they don't come back as inbox items.
      isOwn: Boolean(c.is_own ?? (ownProviderId ? authorId === ownProviderId : false)),
    };
  });
}

export async function replyToComment(
  creds: UnipileCreds,
  accountId: string,
  postId: string,
  text: string,
  commentId?: string,
): Promise<{ id: string | null }> {
  const out = await call<Record<string, unknown>>(
    creds,
    `/posts/${encodeURIComponent(postId)}/comments`,
    {
      method: "POST",
      body: {
        account_id: accountId,
        text,
        ...(commentId ? { comment_id: commentId } : {}),
      },
    },
  );
  return { id: str(out.id) || null };
}

export async function reactToPost(
  creds: UnipileCreds,
  accountId: string,
  postId: string,
  commentId?: string,
): Promise<void> {
  await call(creds, "/posts/reaction", {
    method: "POST",
    body: {
      account_id: accountId,
      post_id: postId,
      reaction_type: "like",
      ...(commentId ? { comment_id: commentId } : {}),
    },
  });
}

// ------------------------------------------------------------------- chats

export type UnipileChat = { id: string; name: string; unread: number; lastAt: string | null };

export async function listChats(
  creds: UnipileCreds,
  accountId: string,
  limit = 25,
): Promise<UnipileChat[]> {
  const out = await call<{ items?: unknown[] }>(creds, "/chats", {
    query: { account_id: accountId, limit },
  });
  return (out.items ?? []).map((raw) => {
    const c = raw as Record<string, unknown>;
    return {
      id: str(c.id),
      name: str(c.name || c.subject),
      unread: Number(c.unread_count ?? c.unread ?? 0) || 0,
      lastAt: pickDate(c),
    };
  });
}

export type UnipileAttendee = {
  id: string;
  providerId: string | null;
  name: string;
  isSelf: boolean;
  pictureUrl: string | null;
  profileUrl: string | null;
};

/** Messages carry only a sender_id — names, avatars and profile urls live here. */
export async function listChatAttendees(
  creds: UnipileCreds,
  chatId: string,
): Promise<UnipileAttendee[]> {
  const out = await call<{ items?: unknown[] }>(
    creds,
    `/chats/${encodeURIComponent(chatId)}/attendees`,
  );
  return (out.items ?? []).map((raw) => {
    const a = raw as Record<string, unknown>;
    return {
      id: str(a.id),
      providerId: str(a.provider_id) || null,
      name: str(a.name),
      isSelf: Boolean(Number(a.is_self ?? 0)),
      pictureUrl: str(a.picture_url) || null,
      profileUrl: str(a.profile_url) || null,
    };
  });
}

export type UnipileMessage = {
  id: string;
  text: string;
  senderName: string;
  senderId: string | null;
  isSender: boolean;
  createdAt: string | null;
};

export async function listChatMessages(
  creds: UnipileCreds,
  chatId: string,
  limit = 15,
): Promise<UnipileMessage[]> {
  const out = await call<{ items?: unknown[] }>(
    creds,
    `/chats/${encodeURIComponent(chatId)}/messages`,
    { query: { limit } },
  );
  return (out.items ?? []).map((raw) => {
    const m = raw as Record<string, unknown>;
    return {
      id: str(m.id),
      text: str(m.text || m.body),
      senderName: str(m.sender_name || (m.sender as Record<string, unknown> | undefined)?.["name"]),
      senderId:
        str(m.sender_id || (m.sender as Record<string, unknown> | undefined)?.["id"]) || null,
      // Unipile marks messages we sent with is_sender = 1.
      isSender: Boolean(Number(m.is_sender ?? 0)),
      createdAt: pickDate(m),
    };
  });
}

export async function sendChatMessage(
  creds: UnipileCreds,
  chatId: string,
  text: string,
): Promise<{ id: string | null }> {
  const out = await call<Record<string, unknown>>(
    creds,
    `/chats/${encodeURIComponent(chatId)}/messages`,
    { method: "POST", body: { text } },
  );
  return { id: str(out.id) || null };
}
