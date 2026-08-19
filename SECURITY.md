# Security

## How this app handles secrets

Social Studio is bring-your-own-key by design. Provider API keys (text models, image
and video models, Buffer, Unipile, Firecrawl, ScrapeCreators, Slack) are
entered per workspace in the app and stored in your own Postgres, encrypted at
rest with AES-GCM using `PROVIDER_KEY_SECRET` from your `.env`. The app
refuses to store keys if that secret is not set.

`.env` holds infrastructure secrets only and is gitignored. Never commit it.

Public endpoints (`/api/public/hooks/*`) fail closed: an unset webhook secret
disables the endpoint rather than leaving it unauthenticated.

## Reporting a vulnerability

Open a GitHub security advisory on this repository (Security → Advisories →
Report a vulnerability), or open an issue asking for a private contact if the
details are sensitive. Please do not disclose publicly before a fix ships.
