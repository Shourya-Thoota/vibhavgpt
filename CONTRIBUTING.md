# Contributing to VibhavGPT

Thanks for your interest in VibhavGPT. This guide covers running the project locally, what a change needs before it can be merged, and how we write commits.

For a security problem, do not open an issue or pull request. Follow [SECURITY.md](SECURITY.md) instead.

## Local setup

You need Node.js 24 (the version production runs) and a PostgreSQL database.

1. Copy the example settings and fill in your own values. Every value in `.env.example` is a placeholder, and the lines for the verification scripts are commented out on purpose.

   ```
   cp .env.example .env
   ```

   At minimum set `DATABASE_URL`, a `BETTER_AUTH_SECRET` of 32 or more characters, `BETTER_AUTH_URL` and `CLIENT_ORIGINS`. Chat, search and images also need the inference, search and model settings described in `.env.example`. Never commit a real `.env` or any key.

2. Install, run the database migrations, and start the API on port 3001:

   ```
   npm install
   npm run db:migrate:programmatic
   npm run dev
   ```

3. In another terminal, start the web app on port 5173. In development it sends `/api` requests to the local API. Optional `VITE_` settings go in `frontend/.env`.

   ```
   npm install --prefix frontend
   npm run dev --prefix frontend
   ```

## Before you open a pull request

Run both of these and make sure they pass:

```
npm test
npm run build --prefix frontend
```

- `npm test` needs no database or network: tests run on an in-memory database with the model and payment providers stubbed. Run one file with `node --experimental-test-module-mocks --import ./test/setup-env.js --test test/<file>.test.js`.
- The frontend build also prerenders the public pages and checks their metadata, headings, FAQs and structured data.
- Add or update tests for the behavior you change. A bug fix should come with a test that fails without it.
- A schema change needs a migration in `drizzle/` (`npm run db:generate`), and the migration must be safe to run on a database that already has data.
- Keep changes focused. Do not mix a refactor with a fix.

## Branches, commits and pull requests

- Work on a branch, not on `main`, and open a pull request. Name the branch for the kind of change: `fix/`, `feat/`, `chore/`, `docs/` or `test/`, then a short description (`fix/account-deletion-audit`).
- Pull requests are squash-merged, so the pull request title becomes the commit on `main`.
- Write the commit subject as a plain sentence in the imperative that says what the change does, for example `Delete account rows atomically, remove files after commit, sign out`. No type prefix, no trailing period, and keep it to about 70 characters.
- Use the body to say why: what was wrong, what changed, and anything a reviewer should check. Wrap it at about 75 characters.
- In the pull request, say what changed, paste the results of the two commands above, and say what you are unsure about.

## Product copy and privacy

- Do not put the names of model or infrastructure providers in the product's user interface, errors or user-visible logs. They belong only on the legal pages.
- Do not use em dashes in text users read.
- Keep the privacy guarantee true: nothing may send user conversations to training, sell user data, or show ads, and logs must not contain prompts, message text, emails or keys.

## License

VibhavGPT is licensed under the GNU Affero General Public License, version 3 only (AGPL-3.0-only); see [LICENSE](LICENSE). By submitting a contribution, you agree that it is licensed under the same terms and that you have the right to submit it.

The names and logos of VibhavGPT and Pansophy are trademarks of Pansophy LLC and are not covered by the license.
