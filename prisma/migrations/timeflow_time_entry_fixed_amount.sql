-- Timeflow fixed amount entry support
-- Safe to re-run.

ALTER TABLE "TimeflowTimeEntry"
  ADD COLUMN IF NOT EXISTS "entryType" TEXT NOT NULL DEFAULT 'time',
  ADD COLUMN IF NOT EXISTS "fixedAmount" DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS "TimeflowTimeEntry_orgUser_entryType_idx"
  ON "TimeflowTimeEntry" ("organizationId", "userId", "entryType");
