// Engagement core: ingest comments / mentions / DMs, classify them, draft
// replies in brand voice, and send them according to the workspace policy.
// Server-only.

import { generateText, Output, NoObjectGeneratedError } from "ai";
import { z } from "zod";
import { resolveChatModel } from "../llm-resolver.server";
import { playbookBlock } from "../playbooks.server";
import { loadBrandBrain } from "../agent-memory.server";
import { logAiUsage } from "../ai-usage.server";
import { notify } from "../notifications.server";
import { logActivity } from "../activity-log";
import {
  requireUnipileCreds,
  listAccounts,
  getOwnProfile,
  listOwnPosts,
  listPostComments,
  listChats,
  listChatAttendees,
  listChatMessages,
  replyToComment,
  sendChatMessage,
  reactToPost,
  type UnipileCreds,
} from "./unipile.server";
import {
  ALWAYS_ESCALATE,
  type EngagementIntent,
  type EngagementKind,
  type EngagementSentiment,
  type ReplyMode,
} from "./types";

type Client = { from: (t: string) => any };

// String.slice can cut an emoji or styled-unicode character in half, leaving a
// lone high surrogate that Postgres rejects as invalid JSON — which would sink
// the entire batch insert. Always truncate with this instead of .slice.
const cut = (s: string, n: number) => s.slice(0, n).replace(/[\uD800-\uDBFF]$/, "");

export type ItemRow = {
  id: string;
  workspace_id: string;
  kind: EngagementKind;
  network: string;
  external_account_id: string;
  external_id: string;
  thread_id: string | null;
  post_id: string | null;
  post_excerpt: string | null;
  permalink: string | null;
  author_name: string;
  author_handle: string | null;
  author_url: string | null;
  author_avatar_url: string | null;
  text: string;
  occurred_at: string | null;
  sentiment: EngagementSentiment | null;
  intent: EngagementIntent | null;
  urgency: string | null;
  should_reply: boolean | null;
  classification: Record<string, unknown>;
  status: string;
};

type Policy = {
  mode: ReplyMode;
  safeCategories: EngagementIntent[];
  dailyLimit: number;
};

export async function loadPolicy(client: Client, workspaceId: string): Promise<Policy> {
  const { data } = await client
    .from("workspaces")
    .select("engagement_reply_mode,engagement_safe_categories,engagement_daily_limit")
    .eq("id", workspaceId)
    .maybeSingle();
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    mode: ((row.engagement_reply_mode as ReplyMode) ?? "draft") || "draft",
    safeCategories: ((row.engagement_safe_categories as EngagementIntent[]) ?? ["praise"]) || [
      "praise",
    ],
    dailyLimit: Number(row.engagement_daily_limit ?? 10) || 0,
  };
}

// --------------------------------------------------------------- ingestion

async function syncedAccounts(client: Client, workspaceId: string, creds: UnipileCreds) {
  const remote = await listAccounts(creds);
  for (const a of remote) {
    await client.from("engagement_accounts").upsert(
      {
        workspace_id: workspaceId,
        provider: "unipile",
        external_account_id: a.id,
        network: a.type,
        name: a.name,
        status: a.status,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,provider,external_account_id" },
    );
  }
  return remote;
}

/**
 * Pulls new comments on our recent posts plus unread DMs into
 * `engagement_items`. Idempotent: existing external ids are skipped.
 */
export async function ingestEngagement(
  client: Client,
  workspaceId: string,
  opts: { postLimit?: number; chatLimit?: number } = {},
): Promise<{ accounts: number; inserted: number; skipped: number; errors: string[] }> {
  const creds = await requireUnipileCreds(client, workspaceId);
  const accounts = await syncedAccounts(client, workspaceId, creds);
  const errors: string[] = [];
  let inserted = 0;
  let skipped = 0;

  const { data: existingRows } = await client
    .from("engagement_items")
    .select("external_id")
    .eq("workspace_id", workspaceId)
    .limit(5000);
  const seen = new Set(
    ((existingRows ?? []) as { external_id: string }[]).map((r) => r.external_id),
  );

  const queue: Record<string, unknown>[] = [];

  for (const account of accounts) {
    if (account.status && account.status !== "OK" && account.status !== "CONNECTED") {
      errors.push(`${account.name}: account status ${account.status}`);
      continue;
    }

    // 1. Comments on our own recent posts.
    try {
      const me = await getOwnProfile(creds, account.id);
      // The posts endpoint 422s ("invalid_recipient") when given the public
      // identifier; it wants the provider id. Verified against the live API.
      const identifier = me.id || me.publicIdentifier;
      if (identifier) {
        const posts = await listOwnPosts(creds, account.id, identifier, opts.postLimit ?? 10);
        for (const post of posts) {
          if (!post.id) continue;
          let comments: Awaited<ReturnType<typeof listPostComments>> = [];
          try {
            comments = await listPostComments(creds, account.id, post.id, 30, me.id);
          } catch (e) {
            errors.push(`comments on ${post.id}: ${e instanceof Error ? e.message : e}`);
            continue;
          }
          for (const c of comments) {
            if (!c.id || c.isOwn || !c.text.trim()) continue;
            const externalId = `comment:${c.id}`;
            if (seen.has(externalId)) {
              skipped++;
              continue;
            }
            seen.add(externalId);
            queue.push({
              workspace_id: workspaceId,
              provider: "unipile",
              external_account_id: account.id,
              network: account.type,
              kind: "comment",
              external_id: externalId,
              thread_id: post.id,
              post_id: post.id,
              post_excerpt: cut(post.text, 240),
              permalink: post.url,
              author_name: c.authorName || "Someone",
              author_handle: c.authorId,
              author_url: c.authorUrl,
              author_avatar_url: c.authorAvatarUrl,
              text: cut(c.text, 4000),
              occurred_at: c.createdAt,
              status: "new",
            });
          }
        }
      }
    } catch (e) {
      errors.push(`${account.name} posts: ${e instanceof Error ? e.message : e}`);
    }

    // 2. Direct messages.
    try {
      const chats = await listChats(creds, account.id, opts.chatLimit ?? 20);
      for (const chat of chats) {
        if (!chat.id) continue;
        let messages: Awaited<ReturnType<typeof listChatMessages>> = [];
        try {
          messages = await listChatMessages(creds, chat.id, 10);
        } catch (e) {
          errors.push(`chat ${chat.id}: ${e instanceof Error ? e.message : e}`);
          continue;
        }
        const incoming = messages.filter((m) => !m.isSender && m.text.trim());
        const latest = incoming[0] ?? null;
        if (!latest) continue;
        const externalId = `dm:${latest.id}`;
        if (seen.has(externalId)) {
          skipped++;
          continue;
        }
        seen.add(externalId);
        // Messages only carry a sender_id; the human-readable identity comes
        // from the attendees endpoint. Best effort — a miss keeps the fallback.
        let author: Awaited<ReturnType<typeof listChatAttendees>>[number] | null = null;
        try {
          const attendees = await listChatAttendees(creds, chat.id);
          author =
            attendees.find((a) => !a.isSelf && a.providerId === latest.senderId) ??
            attendees.find((a) => !a.isSelf) ??
            null;
        } catch {
          /* keep the generic name */
        }
        queue.push({
          workspace_id: workspaceId,
          provider: "unipile",
          external_account_id: account.id,
          network: account.type,
          kind: "dm",
          external_id: externalId,
          thread_id: chat.id,
          post_id: null,
          post_excerpt: messages
            .slice(0, 4)
            .reverse()
            .map((m) => `${m.isSender ? "us" : "them"}: ${cut(m.text, 120)}`)
            .join("\n"),
          permalink: null,
          author_name: author?.name || latest.senderName || chat.name || "Someone",
          author_handle: latest.senderId,
          author_url: author?.profileUrl ?? null,
          author_avatar_url: author?.pictureUrl ?? null,
          text: cut(latest.text, 4000),
          occurred_at: latest.createdAt ?? chat.lastAt,
          status: "new",
        });
      }
    } catch (e) {
      errors.push(`${account.name} chats: ${e instanceof Error ? e.message : e}`);
    }
  }

  if (queue.length) {
    const { data, error } = await client
      .from("engagement_items")
      .upsert(queue, { onConflict: "workspace_id,provider,external_id", ignoreDuplicates: true })
      .select("id");
    if (error) {
      // A batch insert is all-or-nothing: one malformed row rejects every row.
      // Retry one by one so a single bad item costs itself, not the whole sync.
      for (const row of queue) {
        const one = await client
          .from("engagement_items")
          .upsert([row], {
            onConflict: "workspace_id,provider,external_id",
            ignoreDuplicates: true,
          })
          .select("id");
        if (one.error) errors.push(`${row.external_id}: ${one.error.message}`);
        else inserted += ((one.data ?? []) as unknown[]).length;
      }
    } else {
      inserted = ((data ?? []) as unknown[]).length;
    }
  }

  await client
    .from("engagement_accounts")
    .update({ last_synced_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId);

  return { accounts: accounts.length, inserted, skipped, errors: errors.slice(0, 10) };
}

// ------------------------------------------------------------ brand context

async function brandBlock(client: Client, workspaceId: string): Promise<string> {
  const [{ data: profile }, { data: guide }] = await Promise.all([
    client.from("brand_profile").select("*").eq("workspace_id", workspaceId).maybeSingle(),
    client.from("brand_guideline").select("*").eq("workspace_id", workspaceId).maybeSingle(),
  ]);
  const p = (profile ?? {}) as Record<string, unknown>;
  const g = (guide ?? {}) as Record<string, unknown>;
  return [
    p.name ? `Brand: ${p.name} — ${p.industry ?? ""}` : "",
    p.audience ? `Audience: ${p.audience}` : "",
    p.products_services ? `Offer: ${String(p.products_services).slice(0, 400)}` : "",
    g.tone_of_voice ? `Tone: ${g.tone_of_voice}` : "",
    g.writing_style ? `Style: ${String(g.writing_style).slice(0, 300)}` : "",
    g.custom_instructions ? `Rules: ${String(g.custom_instructions).slice(0, 400)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ------------------------------------------------------------ classification

const ClassifySchema = z.object({
  sentiment: z.enum(["positive", "neutral", "negative"]),
  intent: z.enum(["praise", "question", "support", "opportunity", "spam", "other"]),
  urgency: z.enum(["low", "normal", "high"]),
  shouldReply: z.boolean(),
  reason: z.string(),
});

export async function classifyItems(
  client: Client,
  workspaceId: string,
  items: ItemRow[],
): Promise<number> {
  if (!items.length) return 0;
  const brand = await brandBlock(client, workspaceId);
  const { model, modelId } = await resolveChatModel(client as never, workspaceId);
  let done = 0;

  for (const item of items) {
    // Null means "classification failed" — the item still surfaces for a human,
    // but is stamped so it can never slip into the autonomous send path.
    let c: z.infer<typeof ClassifySchema> | null = null;
    try {
      const started = Date.now();
      const result = await generateText({
        model,
        maxOutputTokens: 300,
        system:
          "You triage inbound social media engagement for a brand, like an experienced community manager. " +
          "Classify one message. Be strict: complaints, refunds, bugs and anything a customer is unhappy about are 'support'. " +
          "Sales interest, partnership, press, podcast or speaking requests are 'opportunity'. " +
          "Promotional spam, crypto, or generic bot comments are 'spam' and never deserve a reply.\n\n" +
          (brand ? `BRAND CONTEXT:\n${brand}` : ""),
        prompt:
          `Channel: ${item.network} (${item.kind})\n` +
          (item.post_excerpt ? `Context:\n${item.post_excerpt}\n` : "") +
          `From: ${item.author_name}\nMessage: ${item.text}`,
        output: Output.object({ schema: ClassifySchema }),
      });
      void logAiUsage(client as never, {
        workspaceId,
        model: modelId,
        operation: "engagement.classify",
        usage: result.usage,
        actorType: "agent",
        durationMs: Date.now() - started,
      });

      // In ai@6 `result.output` is a throwing getter whenever the model did not
      // finish cleanly, so a truncated answer must be caught here — never
      // destructured — or one bad item would abort the whole batch.
      if (result.finishReason === "length") {
        console.warn("[engagement] classification truncated at maxOutputTokens for item", item.id);
      } else {
        c = result.output;
      }
    } catch (e) {
      if (NoObjectGeneratedError.isInstance(e)) {
        console.warn(
          "[engagement] classification returned malformed output",
          e.text?.slice(0, 200),
        );
      } else {
        console.warn("[engagement] classify failed", e instanceof Error ? e.message : e);
      }
    }

    if (!c) {
      // A failed classification must not look like a clean "other" (small talk
      // is auto-send safe under some policies): stamp classification.failed so
      // isSafeToAutoSend refuses it, and set intent so the sweep won't loop on
      // re-classifying the same item forever.
      await client
        .from("engagement_items")
        .update({ intent: "other", classification: { failed: true }, status: "needs_reply" })
        .eq("id", item.id);
      continue;
    }

    await client
      .from("engagement_items")
      .update({
        sentiment: c.sentiment,
        intent: c.intent,
        urgency: c.urgency,
        should_reply: c.shouldReply,
        classification: { reason: c.reason.slice(0, 400) },
        status: c.intent === "spam" || !c.shouldReply ? "ignored" : "needs_reply",
      })
      .eq("id", item.id);
    done++;
    await alertForItem(client, workspaceId, { ...item, ...toRowPatch(c) });
  }
  return done;
}

function toRowPatch(c: z.infer<typeof ClassifySchema>): Partial<ItemRow> {
  return {
    sentiment: c.sentiment,
    intent: c.intent,
    urgency: c.urgency,
    should_reply: c.shouldReply,
  };
}

async function alertForItem(client: Client, workspaceId: string, item: Partial<ItemRow>) {
  const who = item.author_name || "Someone";
  const excerpt = cut(item.text ?? "", 220);
  if (item.kind === "dm") {
    await notify(client, workspaceId, "dm", {
      title: `New DM from ${who}`,
      body: excerpt,
      url: "/inbox",
    });
    return;
  }
  if (item.sentiment === "negative") {
    await notify(client, workspaceId, "negative", {
      title: `Negative ${item.kind} from ${who}`,
      body: excerpt,
      url: "/inbox",
    });
  }
  if (item.intent === "opportunity") {
    await notify(client, workspaceId, "opportunity", {
      title: `Opportunity spotted — ${who}`,
      body: excerpt,
      url: "/inbox",
    });
  }
  if (item.intent === "support") {
    await notify(client, workspaceId, "support", {
      title: `Support issue from ${who}`,
      body: excerpt,
      url: "/inbox",
    });
  }
}

// ------------------------------------------------------------------ drafting

export async function draftReplyText(
  client: Client,
  workspaceId: string,
  item: ItemRow,
  angle?: string,
): Promise<string> {
  const [brand, brain, rules] = await Promise.all([
    brandBlock(client, workspaceId),
    loadBrandBrain(client as never, workspaceId).catch(() => ""),
    playbookBlock(client as never, workspaceId, ["engagement"]),
  ]);
  const { model, modelId } = await resolveChatModel(client as never, workspaceId);
  const started = Date.now();
  const { text, usage } = await generateText({
    model,
    maxOutputTokens: 400,
    system: [
      "You write replies to inbound social media engagement on behalf of a brand, in the brand's own voice.",
      "Reply as a thoughtful human would: acknowledge the person by first name when natural, add one specific thought, keep it short.",
      "Never invent facts, prices, dates or commitments. Never apologise for something you cannot verify.",
      "Output ONLY the reply text — no quotes, no preamble, no signature.",
      brand ? `BRAND CONTEXT:\n${brand}` : "",
      brain ? `WHAT WE HAVE LEARNED:\n${brain}` : "",
      rules,
    ]
      .filter(Boolean)
      .join("\n\n"),
    prompt:
      `Channel: ${item.network} (${item.kind}). Sentiment: ${item.sentiment ?? "unknown"}. Intent: ${item.intent ?? "unknown"}.\n` +
      (item.post_excerpt ? `Context:\n${item.post_excerpt}\n` : "") +
      `From ${item.author_name}: ${item.text}\n` +
      (angle ? `\nExtra instruction from the user: ${angle}` : "") +
      `\n\nWrite the reply (${item.kind === "dm" ? "up to 4 sentences" : "1-3 sentences"}).`,
  });
  void logAiUsage(client as never, {
    workspaceId,
    model: modelId,
    operation: "engagement.draft",
    usage,
    actorType: "agent",
    durationMs: Date.now() - started,
  });
  return text
    .trim()
    .replace(/^["“]|["”]$/g, "")
    .slice(0, 1200);
}

async function autonomousSentToday(client: Client, workspaceId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await client
    .from("engagement_replies")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("mode", "autonomous")
    .eq("status", "sent")
    .gte("sent_at", since)
    .limit(200);
  return ((data ?? []) as unknown[]).length;
}

export function isSafeToAutoSend(item: ItemRow, policy: Policy): boolean {
  if (policy.mode !== "autonomous") return false;
  if (item.sentiment === "negative") return false;
  // Items whose classification failed carry intent "other" only as a
  // placeholder — a human must look at them, never the autonomous path.
  if (item.classification && (item.classification as Record<string, unknown>).failed) return false;
  const intent = (item.intent ?? "other") as EngagementIntent;
  if (ALWAYS_ESCALATE.includes(intent)) return false;
  return policy.safeCategories.includes(intent);
}

/**
 * Drafts a reply for an item and routes it according to the workspace policy:
 * draft only, approval queue, or autonomous send for safe categories.
 */
export async function handleItem(
  client: Client,
  workspaceId: string,
  item: ItemRow,
  policy: Policy,
): Promise<{ status: string; replyId: string | null }> {
  if (item.should_reply === false || item.intent === "spam") {
    await client.from("engagement_items").update({ status: "ignored" }).eq("id", item.id);
    return { status: "ignored", replyId: null };
  }

  const text = await draftReplyText(client, workspaceId, item);

  const auto = isSafeToAutoSend(item, policy);
  let mode: string = policy.mode;
  let status: string = "draft";

  if (auto) {
    const used = await autonomousSentToday(client, workspaceId);
    if (policy.dailyLimit > 0 && used >= policy.dailyLimit) {
      mode = "approval";
      status = "awaiting_approval";
    } else {
      mode = "autonomous";
      status = "approved";
    }
  } else if (policy.mode === "approval") {
    status = "awaiting_approval";
  }

  const { data: reply, error } = await client
    .from("engagement_replies")
    .insert({ workspace_id: workspaceId, item_id: item.id, text, mode, status })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const replyId = (reply as { id: string }).id;

  if (status === "approved") {
    const sent = await sendReply(client, workspaceId, item.id, text, replyId, "autonomous");
    return { status: sent.ok ? "replied" : "escalated", replyId };
  }

  const itemStatus = status === "awaiting_approval" ? "awaiting_approval" : "drafted";
  await client.from("engagement_items").update({ status: itemStatus }).eq("id", item.id);

  if (status === "awaiting_approval") {
    await notify(client, workspaceId, "approval", {
      title: `Reply awaiting approval — ${item.author_name}`,
      body: `They said: "${cut(item.text, 160)}"\nDraft: "${cut(text, 200)}"`,
      url: "/inbox",
    });
  }
  return { status: itemStatus, replyId };
}

// ------------------------------------------------------------------- sending

export type SendReplyResult = { ok: boolean; error?: string; queued?: boolean; note?: string };

/**
 * Sends a reply through Unipile. This is the single choke point: it re-reads
 * the item, never trusts a client-supplied target, and enforces the workspace
 * reply policy itself — callers that did not get an explicit human go-ahead
 * (`opts.userConfirmed`) are queued for approval instead of sent when the
 * mode demands it, or when the autonomous daily budget is spent.
 */
export async function sendReply(
  client: Client,
  workspaceId: string,
  itemId: string,
  text: string,
  replyId?: string,
  mode: string = "manual",
  opts: { userConfirmed?: boolean } = {},
): Promise<SendReplyResult> {
  const { data } = await client
    .from("engagement_items")
    .select("*")
    .eq("id", itemId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const item = data as ItemRow | null;
  if (!item) return { ok: false, error: "Item not found." };

  const clean = text.trim();
  if (!clean) return { ok: false, error: "Reply is empty." };

  // A human pressing "send" overrides the policy gate — the gate exists to
  // stop unattended sends, not people.
  if (!opts.userConfirmed) {
    const policy = await loadPolicy(client, workspaceId);
    let queueNote: string | null = null;
    if (policy.mode === "draft" || policy.mode === "approval") {
      queueNote = `Reply mode is ${policy.mode} — queued for human approval, not sent.`;
    } else {
      const used = await autonomousSentToday(client, workspaceId);
      if (policy.dailyLimit > 0 && used >= policy.dailyLimit) {
        queueNote = `Daily autonomous reply limit (${policy.dailyLimit}) reached — queued for human approval, not sent.`;
      }
    }
    if (queueNote) {
      if (replyId) {
        await client
          .from("engagement_replies")
          .update({ text: clean, status: "queued", mode })
          .eq("id", replyId);
      } else {
        await client.from("engagement_replies").insert({
          workspace_id: workspaceId,
          item_id: itemId,
          text: clean,
          mode,
          status: "queued",
        });
      }
      await client
        .from("engagement_items")
        .update({ status: "awaiting_approval" })
        .eq("id", itemId);
      await notify(client, workspaceId, "approval", {
        title: `Reply awaiting approval — ${item.author_name}`,
        body: `They said: "${cut(item.text, 160)}"\nDraft: "${cut(clean, 200)}"`,
        url: "/inbox",
      });
      return { ok: true, queued: true, note: queueNote };
    }
  }

  let error: string | null = null;
  let externalId: string | null = null;
  try {
    const creds = await requireUnipileCreds(client, workspaceId);
    if (item.kind === "dm") {
      if (!item.thread_id) throw new Error("This conversation has no chat id.");
      const res = await sendChatMessage(creds, item.thread_id, clean);
      externalId = res.id;
    } else {
      if (!item.post_id) throw new Error("This comment has no parent post id.");
      const commentId = item.external_id.startsWith("comment:")
        ? item.external_id.slice("comment:".length)
        : undefined;
      const res = await replyToComment(
        creds,
        item.external_account_id,
        item.post_id,
        clean,
        commentId,
      );
      externalId = res.id;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const now = new Date().toISOString();
  if (replyId) {
    await client
      .from("engagement_replies")
      .update({
        text: clean,
        status: error ? "failed" : "sent",
        sent_at: error ? null : now,
        external_id: externalId,
        error,
        mode,
      })
      .eq("id", replyId);
  } else {
    await client.from("engagement_replies").insert({
      workspace_id: workspaceId,
      item_id: itemId,
      text: clean,
      mode,
      status: error ? "failed" : "sent",
      sent_at: error ? null : now,
      external_id: externalId,
      error,
    });
  }

  await client
    .from("engagement_items")
    .update({ status: error ? "escalated" : "replied" })
    .eq("id", itemId);

  await logActivity(
    {
      workspaceId,
      actorType: mode === "manual" ? "user" : "agent",
      action: error ? "engagement.reply_failed" : "engagement.replied",
      summary: error
        ? `Reply to ${item.author_name} failed: ${error.slice(0, 120)}`
        : `Replied to ${item.author_name} on ${item.network}`,
      status: error ? "error" : "ok",
      error,
      details: { kind: item.kind, mode },
      relatedType: "engagement_item",
      relatedId: itemId,
    },
    client as never,
  );

  if (error) {
    await notify(client, workspaceId, "failure", {
      title: "Could not send a reply",
      body: error.slice(0, 300),
      url: "/inbox",
    });
  }
  return error ? { ok: false, error } : { ok: true };
}

export async function likeItem(
  client: Client,
  workspaceId: string,
  itemId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { data } = await client
    .from("engagement_items")
    .select("*")
    .eq("id", itemId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const item = data as ItemRow | null;
  if (!item) return { ok: false, error: "Item not found." };
  if (item.kind === "dm" || !item.post_id)
    return { ok: false, error: "Only comments can be liked." };
  try {
    const creds = await requireUnipileCreds(client, workspaceId);
    const commentId = item.external_id.startsWith("comment:")
      ? item.external_id.slice("comment:".length)
      : undefined;
    await reactToPost(creds, item.external_account_id, item.post_id, commentId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not like." };
  }
}

// -------------------------------------------------------------- orchestration

/** Full sweep: ingest, classify, then draft/route according to policy. */
export async function runEngagementSweep(
  client: Client,
  workspaceId: string,
  opts: { autoDraft?: boolean; autoSend?: boolean } = {},
): Promise<{ inserted: number; classified: number; handled: number; errors: string[] }> {
  const ingest = await ingestEngagement(client, workspaceId);

  const { data: fresh } = await client
    .from("engagement_items")
    .select("*")
    .eq("workspace_id", workspaceId)
    .is("intent", null)
    .order("occurred_at", { ascending: false })
    .limit(25);
  const classified = await classifyItems(client, workspaceId, (fresh ?? []) as ItemRow[]);

  let handled = 0;
  if (opts.autoDraft !== false) {
    const loaded = await loadPolicy(client, workspaceId);
    // autoSend:false lets unattended callers (the heartbeat) triage and draft
    // without ever taking the autonomous send branch, whatever the workspace
    // policy says — downgrade autonomous to draft for this sweep only.
    const policy: Policy =
      opts.autoSend === false && loaded.mode === "autonomous"
        ? { ...loaded, mode: "draft" }
        : loaded;
    const { data: pending } = await client
      .from("engagement_items")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("status", "needs_reply")
      .order("occurred_at", { ascending: false })
      .limit(15);
    for (const item of (pending ?? []) as ItemRow[]) {
      try {
        await handleItem(client, workspaceId, item, policy);
        handled++;
      } catch (e) {
        ingest.errors.push(e instanceof Error ? e.message : String(e));
      }
    }
  }

  return { inserted: ingest.inserted, classified, handled, errors: ingest.errors };
}

/** Compact inbox state for the heartbeat / chat prompt. */
export async function loadInboxDigest(client: Client, workspaceId: string): Promise<string> {
  try {
    const { data } = await client
      .from("engagement_items")
      .select("kind,network,author_name,text,sentiment,intent,status")
      .eq("workspace_id", workspaceId)
      .in("status", ["needs_reply", "drafted", "awaiting_approval", "escalated"])
      .order("occurred_at", { ascending: false })
      .limit(12);
    const rows = (data ?? []) as Array<Record<string, string>>;
    if (!rows.length) return "";
    const lines = rows.map(
      (r) =>
        `- [${r.network}/${r.kind}] ${r.author_name} (${r.sentiment ?? "?"}, ${r.intent ?? "?"}, ${r.status}): "${(r.text ?? "").slice(0, 120)}"`,
    );
    return `${rows.length} item(s) waiting in the engagement inbox:\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}
