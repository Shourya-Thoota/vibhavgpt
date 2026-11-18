-- Who owns which connected account (src/connectors/account-ownership.js). The production gateway is reached with one shared consumer key and
-- lists every caller the same accounts with no owner marker, so ownership cannot be read from that list. Instead, each Connect press gets an
-- unguessable alias, stored here against the person who pressed it and passed to the gateway's "add"; the account that later carries that alias
-- is recorded here as theirs. Additive only: a new table, nothing existing is altered. It holds no tokens or message content.
CREATE TABLE IF NOT EXISTS "connector_account_owners" (
  -- The alias given to the gateway for one Connect press, for one app ("vgc_<hex>-<hex>").
  "alias" text PRIMARY KEY,
  "user_id" text NOT NULL,
  -- The toolkit the person connected (for example google_workspace) and the gateway app the alias was used for (for example gmail).
  "toolkit" text NOT NULL,
  "app" text NOT NULL,
  -- The connected account that carries the alias, once the gateway lists it. One account has at most one owner.
  "account_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "claimed_at" timestamp with time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS "connector_account_owners_account_unique" ON "connector_account_owners" ("account_id");
CREATE INDEX IF NOT EXISTS "connector_account_owners_user_idx" ON "connector_account_owners" ("user_id");
