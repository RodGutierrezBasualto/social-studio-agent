// Unipile webhook receiver. Unipile posts here when a new message or comment
// arrives. The payload only triggers a sweep for the workspace named in the
// hosted-link `name` field — we never trust content from the body.

import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const Payload = z.object({
  name: z.string().uuid().optional(),
  account_id: z.string().optional(),
  status: z.string().optional(),
  event: z.string().optional(),
});

export const Route = createFileRoute("/api/public/hooks/unipile")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Fails closed like cron-tick: an unset secret disables the endpoint
        // instead of leaving it unauthenticated on fresh clones.
        const secret = process.env["UNIPILE_WEBHOOK_SECRET"];
        if (!secret)
          return new Response("Webhook disabled: UNIPILE_WEBHOOK_SECRET is not set.", {
            status: 503,
          });
        if (request.headers.get("x-webhook-secret") !== secret) {
          return new Response("Unauthorized", { status: 401 });
        }

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return new Response("Bad request", { status: 400 });
        }
        const parsed = Payload.safeParse(body);
        const workspaceId = parsed.success ? parsed.data.name : undefined;
        if (!workspaceId) return Response.json({ ok: true, skipped: "no workspace" });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: ws } = await supabaseAdmin
          .from("workspaces")
          .select("id")
          .eq("id", workspaceId)
          .maybeSingle();
        if (!ws) return Response.json({ ok: true, skipped: "unknown workspace" });

        try {
          const { runEngagementSweep } = await import("@/lib/engagement/engagement.server");
          const out = await runEngagementSweep(supabaseAdmin as never, workspaceId);
          return Response.json({ ok: true, inserted: out.inserted, handled: out.handled });
        } catch (e) {
          console.error("[unipile webhook] sweep failed", e instanceof Error ? e.message : e);
          return Response.json({ ok: false }, { status: 500 });
        }
      },
    },
  },
});
