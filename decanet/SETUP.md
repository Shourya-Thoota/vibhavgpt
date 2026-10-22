# DECANet setup

DECANet is a VibhavGPT product: a DECA role-play practice site at
decanet.vibhavgpt.com. It has two parts:

- **The web app** in this folder (`decanet/`), a static Vite + React site
  served by Caddy.
- **The API** at `/api/decanet/*` in the main VibhavGPT server
  (`src/decanet/`), using the same Postgres database (migration
  `drizzle/0028_decanet.sql`, applied automatically by `npm start`).

## 1. OpenAI

1. Create a project and API key at platform.openai.com.
2. Set a monthly budget limit on that project (for example $50 to start).
3. Make sure the project can use **gpt-realtime-2.1-mini** (the judge),
   **gpt-4o-mini-transcribe** (the transcript, filler words included) and
   **o4-mini** (scoring).

## 2. API service (the existing VibhavGPT Railway service)

Add these variables:

| Variable | Value |
| --- | --- |
| `DECANET_OPENAI_API_KEY` | the key from step 1 |
| `DECANET_REALTIME_MODEL` | `gpt-realtime-2.1-mini` (the default) |
| `DECANET_GRADER_MODEL` | `o4-mini` (the default) |
| `DECANET_APP_URL` | `https://decanet.vibhavgpt.com` |
| `CLIENT_ORIGINS` | append `,https://decanet.vibhavgpt.com` to the **end** (the first entry must stay vibhavgpt.com) |

Password-reset emails use the existing `RESEND_API_KEY`. They are sent from
`DECANET_EMAIL_FROM` (default `DECANet by VibhavGPT <support@pansophy.com>`).

## 3. Stripe

Nothing to create. DECANet uses your existing `STRIPE_SECRET_KEY` with inline
prices, and the **existing webhook** at
`https://api.vibhavgpt.com/api/webhooks/stripe` already handles DECANet
purchases (they are tagged `metadata.app = decanet`). Make sure that webhook
sends `checkout.session.completed` and
`checkout.session.async_payment_succeeded`. Credits are also confirmed when
the buyer returns to DECANet, so a slow webhook never leaves anyone waiting.

## 4. Web app service (new Railway service)

1. Railway → New service → this GitHub repo.
2. Settings → Root directory: `decanet`.
3. Build command `npm run build`. Railpack serves `dist/` with the
   `Caddyfile` in this folder.
4. Networking → custom domain `decanet.vibhavgpt.com` (and optionally
   `www.decanet.vibhavgpt.com`, which redirects to it).
5. At your DNS provider, add the CNAME record(s) Railway shows.

The app calls `https://api.vibhavgpt.com` by default. To point it elsewhere,
set `VITE_API_URL` at build time, and update `connect-src` in the Caddyfile to
match.

## Local development

```sh
# API (from the repo root), with a local Postgres in DATABASE_URL
CLIENT_ORIGINS=http://localhost:5173,http://localhost:5174 DECANET_APP_URL=http://localhost:5174 npm run dev
# Web app
cd decanet && npm install && npm run dev   # http://localhost:5174
```

## How costs stay under $0.85 per role-play

- The judge speaks only on cue (`create_response: false`). The browser cues
  it to greet, answer the participant's questions, ask two questions and close.
- Judge turns are capped at 450 output tokens.
- The server hangs up every call 20 seconds after the role-play clock ends,
  whatever the browser does, and allows at most 5 reconnects per role-play.
- Each finished role-play logs `decanet.roleplay.finished` with its token usage
  and an estimated cost (set the `DECANET_PRICE_*` variables to OpenAI's current
  prices for accurate numbers).
