# Social Studio

An open-source AI social media studio that runs on your machine. A chat agent
that writes in **your** brand voice, generates on-brand images and video,
schedules and publishes through Buffer, watches your engagement inbox, studies
competitors, and runs autonomous automations — with you holding the approval
queue.

**Bring your own keys.** Social Studio ships with no platform accounts and no vendor
lock-in: you connect your own model provider (Anthropic, OpenAI, Google, or
any OpenAI-compatible endpoint), your own image/video providers, and your own
service accounts. Keys are stored encrypted in your own local database.

## What it does

- **Chat agent** with 40+ tools: write and schedule posts, generate images and
  video clips, assemble LinkedIn carousels, read reference posts you paste,
  research the web, analyze competitors, and manage its own automations.
- **Publishing** through Buffer (LinkedIn, Instagram, X, …): queue, exact-time,
  or publish-now, with native image/video/document attachments.
- **Engagement inbox** via Unipile: comments, mentions, and DMs from your
  linked accounts, with drafted replies that wait for your approval.
- **Brand brain**: a brand profile + guide the agent treats as the source of
  truth, plus a library of approved visuals and a memory of corrections you've
  given it.
- **Automations**: cron-scheduled jobs (daily drafts, weekly competitor scans)
  that run in the background and leave an activity log.

## Prerequisites

- **Node.js ≥ 20.12** (uses `process.loadEnvFile`)
- **npm** (the repo ships `package-lock.json`; don't use bun)
- **Docker Desktop** (Supabase runs locally in containers)
- **[Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)** installed globally

## Quick start

```bash
git clone <this-repo>
cd social-studio-agent
npm install
npm run db:start          # local Supabase: Postgres, Auth, Storage, Studio
cp .env.example .env
```

Fill in `.env`:

1. `supabase status` prints the **publishable key** and **secret (service
   role) key** — paste them into the four Supabase variables (the two `VITE_`
   ones repeat the URL and publishable key).
2. Generate the secrets: `openssl rand -hex 32` for `PROVIDER_KEY_SECRET`
   (encrypts your saved API keys — required) and again for `CRON_TICK_SECRET`.

Then:

```bash
npm run dev               # http://localhost:5173
```

Sign up at `/auth` (email confirmation is disabled locally; a workspace is
created automatically), then — **important** — go to **Settings → Connections
and add a model API key**. The agent is bring-your-own-key: until a text-model
key is connected, chat will tell you it has no model rather than answering.

Optionally seed a demo brand so the agent has a voice to write in:

```bash
npm run seed:brand        # loads seed/brand.example.json (or your gitignored seed/brand.local.json)
```

Then edit `/marca` and `/guia` in the app to make the brand yours.

## Optional connections

Everything below is off until you connect it — the app degrades gracefully:

| Feature                       | Needs                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| Real publishing               | A [Buffer](https://buffer.com) access token                                                 |
| Image generation              | OpenAI, Google Gemini, or Azure key (Settings → Connections)                                |
| Video generation              | Google Veo / Gemini Omni Flash, Seedance (BytePlus), Kling, or Runway key                   |
| Engagement inbox              | A [Unipile](https://unipile.com) account with your LinkedIn connected                       |
| Web search / competitor scans | [Firecrawl](https://firecrawl.dev) and/or [ScrapeCreators](https://scrapecreators.com) keys |
| Media on published posts      | `PUBLIC_APP_URL` set to a public https URL (`npm run tunnel` via ngrok)                     |

## Automations (background jobs)

Automations advance on a once-a-minute tick. Fire it manually with
`npm run cron:once`, or install a scheduler:

- **macOS**: `npm run cron:install` (launchd agent; `npm run cron:uninstall` to remove)
- **Linux**: add `* * * * * cd /path/to/repo && ./scripts/cron-tick.sh` to your crontab

The honest limitation of running locally: automations only advance while the
app is running and your machine is awake.

## Production build

```bash
npm run build             # → .output/server/index.mjs
node .output/server/index.mjs
```

Note: nothing auto-loads `.env` for the production server — export the
variables into the shell (or use your host's secret manager) before starting.
Set `NITRO_PRESET=cloudflare-module` to target Cloudflare Workers.

## Learn more

More depth: [DOCUMENTATION.md](DOCUMENTATION.md) (architecture, every
subsystem, honest limitations) and [docs/overview.md](docs/overview.md)
(non-technical tour of what the agent can do).

## License

[MIT](LICENSE)
