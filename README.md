# VibhavGPT

VibhavGPT is a private AI workspace for chat, image creation and study, with
memory you control. No training on your chats, no data sales, no ads.

- `src/`: the API (accounts, chat, memory, billing, usage, search)
- `frontend/`: the web app
- `drizzle/`: database migrations
- `test/`: automated tests

## Run it locally

You need Node.js and a PostgreSQL database.

1. Copy the example settings and fill in your own values. Every value in
   `.env.example` is a placeholder.

   ```bash
   cp .env.example .env
   ```

   At minimum set `DATABASE_URL`, a `BETTER_AUTH_SECRET` of 32 or more
   characters, `BETTER_AUTH_URL` and `CLIENT_ORIGINS`. Chat, search, images
   and voice also need the inference, search and model settings described in
   `.env.example`.

2. Start the API on port 3001:

   ```bash
   npm install
   npm run db:migrate:programmatic
   npm run dev
   ```

3. Start the web app on port 5173. In development it sends `/api` requests to
   the local API. Optional `VITE_` settings go in `frontend/.env`.

   ```bash
   npm install --prefix frontend
   npm run dev --prefix frontend
   ```

4. Run the tests and the production build:

   ```bash
   npm test
   npm run build --prefix frontend
   ```

The Windows and Android downloads live on the vibhavgpt.com download pages.

## License

Copyright (C) 2026 Pansophy LLC

VibhavGPT is licensed under the GNU Affero General Public License, version 3
only. See [LICENSE](LICENSE) for the full text.

The VibhavGPT and Pansophy names and logos are not covered by the license.
