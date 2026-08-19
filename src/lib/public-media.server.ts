// Makes Supabase Storage signed URLs reachable from the public internet.
//
// Buffer downloads post media from its own servers. That is fine when Supabase
// is hosted, but a local stack signs URLs against http://127.0.0.1:54321, which
// Buffer cannot resolve — every post with an image or video would fail with an
// unhelpful upstream error.
//
// When PUBLIC_APP_URL is set, signed URLs are rewritten to travel through this
// app's own /api/public/media proxy, which is exposed by the same tunnel that
// serves inbound webhooks. The signed token is preserved, so access control is
// unchanged.
//
// When PUBLIC_APP_URL is empty the URL is returned untouched, which is the
// correct behaviour for a hosted Supabase deployment.

const STORAGE_PREFIX = "/storage/v1/";

export function publicAppUrl(): string | null {
  const raw = process.env.PUBLIC_APP_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

/**
 * Rewrites a Supabase signed URL to go through the public media proxy.
 * Returns the input unchanged when no public URL is configured or the URL is
 * not a Supabase storage URL.
 */
export function toPublicMediaUrl(signedUrl: string): string {
  const base = publicAppUrl();
  if (!base) return signedUrl;

  let parsed: URL;
  try {
    parsed = new URL(signedUrl);
  } catch {
    return signedUrl;
  }

  const idx = parsed.pathname.indexOf(STORAGE_PREFIX);
  if (idx === -1) return signedUrl;

  const rest = parsed.pathname.slice(idx + STORAGE_PREFIX.length);
  return `${base}/api/public/media/${rest}${parsed.search}`;
}

/**
 * Throws when media is about to be handed to an external service that could
 * never fetch it. Failing here produces an actionable message instead of a
 * confusing rejection from the other side.
 */
export function assertPubliclyFetchable(url: string, what: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`${what} is not a valid URL.`);
  }
  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".local") ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (isLocal) {
    throw new Error(
      `${what} is only reachable at ${host}, so Buffer cannot download it. ` +
        `Start the tunnel (npm run tunnel) and set PUBLIC_APP_URL in .env to the public URL it prints, then restart the dev server.`,
    );
  }
}
