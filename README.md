# Validcraft

A real-time-strategy style replay of a company's week. People, clients and automations are units on a map; the tools they work in are buildings; tickets, threads, pull requests, videos and ads move between them as the week plays back.

## Try it

```
npm install
npm run dev
```

With no data of your own, the map plays `fixtures/replay.sample.json`, two synthetic days made by `npm run fixture`.

## Use your own data

1. Copy `rts.config.example.json` to `rts.config.json` and fill in your company, clients and workspace names.
2. Copy `.env.example` to `.env` and set the keys for the sources you want. A source without its key is skipped or fails on its own without stopping the others. The registry needs `SLACK_BOT_TOKEN`, `LINEAR_API_KEY` and `NOTION_API_KEY` together; without it the replay is built with nobody matched across tools.
3. Run `npm run pull`, which also runs the registry, then `npm run build:data`.
4. Run `npm run dev`.

Each source can also be pulled alone, for example `npm run pull:linear`. Raw pages are saved under `data/raw` as they arrive, so a stopped pull resumes where it left off and never asks an API for the same page twice.

| Source | Reads | Needs |
| --- | --- | --- |
| `pull:linear` | issues, history, comments | `LINEAR_API_KEY` |
| `pull:github` | pull requests, reviews, commits | the `gh` CLI, `github.org` |
| `pull:slack` | messages, threads, reactions | `SLACK_BOT_TOKEN`, plus `SLACK_BOT_TOKEN_2` for channels only a second bot is in, or `SLACK_EXPORT` pointing at an export zip |
| `pull:notion` | pages and database rows | `NOTION_API_KEY` |
| `pull:calendar` | meetings and time away | `GOOGLE_SERVICE_ACCOUNT_KEY` with domain-wide delegation |
| `pull:sentry` | error events | `SENTRY_AUTH_TOKEN`, `sentry.org`, `sentry.project` |
| `pull:meta-activity` | ad account activity log | `META_ACCESS_TOKEN`, `clients[].metaAccounts` |
| `pull:tiktok-activity` | advertiser change log | `TIKTOK_ACCESS_TOKEN`, `clients[].tiktokAdvertisers` |
| `pull:spend` | Anthropic, OpenAI and Google Cloud costs | `ANTHROPIC_ADMIN_KEY`, `OPENAI_ADMIN_KEY`, `spend.*` |
| `pull:ops` | incidents, deployments, CI runs | `INCIDENT_IO_API_KEY`, `VERCEL_TOKEN`, the `gh` CLI |
| `pull:workspace` | Google Workspace audit logs | `GOOGLE_SERVICE_ACCOUNT_KEY`, `workspace.*` |
| `pull:sessions` | Claude Code, Cowork and chat sessions | local Claude logs, `CLAUDE_EXPORT` |

`npm run registry` works out who is who: it reads the Slack, Linear and Notion directories, matches each client in `rts.config.json` to its shared channels and projects, and joins one person's accounts across tools. Fixes go in `data/registry-overrides.json`.

Setting `bucket` (or `RTS_BUCKET`) to a `gs://` path keeps each week's pull and the built replay library in Google Cloud Storage through the `gcloud` CLI.

## Your own replay file

The viewer only needs a replay file. `src/schema.ts` describes it, and `scripts/make-fixture.ts` builds one from scratch. Put yours at `data/replay.json`.

## Hosting

`middleware.ts`, `api/` and `vercel.json` put the built map on Vercel behind Google sign-in, limited to the emails in `RTS_ALLOWED_EMAILS`. The hosted map reads its data from the bucket, so it needs `RTS_BUCKET` filled by `npm run build:parquet`, `GCS_SIGNER_KEY` (a service account JSON that can read the bucket), `AUTH_SECRET`, and `GOOGLE_CLIENT_ID` with `GOOGLE_CLIENT_SECRET` for a Google OAuth client. `RTS_GOOGLE_DOMAIN` limits the sign-in screen to one Google Workspace domain. Sign-in attempts from emails not on the list are written to the function log.

The dev server has no sign-in. Do not expose it beyond your own machine.

Weeks are cut at midnight Pacific time.

## License

MIT. See `LICENSE`.
