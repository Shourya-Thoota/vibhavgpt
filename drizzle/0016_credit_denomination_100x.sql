-- Move from 10 credits per USD to 100 credits per USD without rewriting the
-- append-only ledger. Each account gets one compensating 9x balance entry;
-- the unique external reference makes this safe to re-run.
INSERT INTO "credit_ledger" ("user_id", "credits", "kind", "external_reference")
SELECT
  "user_id",
  (SUM("credits") * 9)::integer,
  'credit_denomination_migration',
  'credit-denomination-100x:' || "user_id"
FROM "credit_ledger"
GROUP BY "user_id"
HAVING SUM("credits") <> 0
ON CONFLICT ("external_reference") DO NOTHING;
