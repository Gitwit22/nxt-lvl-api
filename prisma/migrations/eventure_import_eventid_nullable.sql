-- Make event linkage optional for org-level Eventure sponsor imports.
-- Safe change: dropping NOT NULL does not rewrite table data.

ALTER TABLE "EventureImportBatch"
  ALTER COLUMN "eventId" DROP NOT NULL;

ALTER TABLE "EventureImportRow"
  ALTER COLUMN "eventId" DROP NOT NULL;
