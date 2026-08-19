// Public read-only proxy in front of Supabase Storage.
//
// Buffer fetches post media from its own servers, so the URL we hand it must be
// reachable from the public internet. When Supabase runs locally its storage
// endpoint is 127.0.0.1 only, so signed URLs are rewritten to point here (see
// toPublicMediaUrl in src/lib/public-media.server.ts) and this route forwards
// the request to the real storage endpoint.
//
// Auth: none of its own, by design. The forwarded path carries Supabase's own
// signed-URL token, which this route passes through untouched — the signature
// is what grants access, exactly as it would if Buffer hit storage directly.
// Only GET and HEAD are forwarded, so this can never be used to write.

import { createFileRoute } from "@tanstack/react-router";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
]);

async function forward(request: Request, params: Record<string, string | undefined>) {
  const base = process.env.SUPABASE_URL;
  if (!base) {
    console.error("[media-proxy] SUPABASE_URL not configured");
    return new Response("Server misconfigured", { status: 500 });
  }

  // TanStack's splat param holds everything after /api/public/media/.
  const splat = params._splat ?? "";
  if (!splat || splat.includes("..")) return new Response("Not found", { status: 404 });

  const target = new URL(`${base.replace(/\/+$/, "")}/storage/v1/${splat}`);
  target.search = new URL(request.url).search;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: { accept: request.headers.get("accept") ?? "*/*" },
      redirect: "follow",
    });
  } catch (e) {
    console.error("[media-proxy] upstream fetch failed", e instanceof Error ? e.message : e);
    return new Response("Bad gateway", { status: 502 });
  }

  if (!upstream.ok) {
    console.warn(`[media-proxy] ${request.method} ${splat} → ${upstream.status}`);
  }

  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });
  // Buffer may re-fetch the asset; let it and any CDN in between cache it.
  if (!headers.has("cache-control")) headers.set("cache-control", "public, max-age=3600");

  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
}

// Without these, a write verb falls through to the SSR renderer and answers
// 200 with the app shell — which reads like the write succeeded.
const methodNotAllowed = async () =>
  new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });

export const Route = createFileRoute("/api/public/media/$")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        forward(request, params as Record<string, string | undefined>),
      HEAD: async ({ request, params }) =>
        forward(request, params as Record<string, string | undefined>),
      POST: methodNotAllowed,
      PUT: methodNotAllowed,
      PATCH: methodNotAllowed,
      DELETE: methodNotAllowed,
    },
  },
});
