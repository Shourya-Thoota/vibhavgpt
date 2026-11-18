-- Sidebar customization (src/profile/preferences.js): the sidebar items a person chose to hide, as a JSON array of item ids from a fixed
-- list (SIDEBAR_ITEM_IDS). Additive only: a new column with an empty default, so every existing account keeps its full sidebar.
ALTER TABLE "account_preferences" ADD COLUMN IF NOT EXISTS "sidebar_hidden" jsonb DEFAULT '[]'::jsonb NOT NULL;
