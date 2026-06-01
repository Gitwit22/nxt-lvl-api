ALTER TABLE "EventureSponsorshipPackage"
  ADD COLUMN IF NOT EXISTS "sourceImportRowId" TEXT,
  ADD COLUMN IF NOT EXISTS "importSource" TEXT,
  ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);

ALTER TABLE "EventureEventFlightSlot"
  ADD COLUMN IF NOT EXISTS "sourceImportRowId" TEXT,
  ADD COLUMN IF NOT EXISTS "importSource" TEXT,
  ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);

ALTER TABLE "EventureEventVolunteerNeed"
  ADD COLUMN IF NOT EXISTS "sourceImportRowId" TEXT,
  ADD COLUMN IF NOT EXISTS "importSource" TEXT,
  ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);

ALTER TABLE "EventureSponsorOrganization"
  ADD COLUMN IF NOT EXISTS "sourceImportRowId" TEXT,
  ADD COLUMN IF NOT EXISTS "importSource" TEXT;

ALTER TABLE "EventureSponsorContact"
  ADD COLUMN IF NOT EXISTS "sourceImportRowId" TEXT,
  ADD COLUMN IF NOT EXISTS "importSource" TEXT;

ALTER TABLE "EventureEventSponsor"
  ADD COLUMN IF NOT EXISTS "sourceImportRowId" TEXT,
  ADD COLUMN IF NOT EXISTS "importSource" TEXT;

ALTER TABLE "EventureSponsorYearHistory"
  ADD COLUMN IF NOT EXISTS "sourceImportRowId" TEXT,
  ADD COLUMN IF NOT EXISTS "importSource" TEXT,
  ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);

ALTER TABLE "EventureSponsorFollowUp"
  ADD COLUMN IF NOT EXISTS "sourceImportRowId" TEXT,
  ADD COLUMN IF NOT EXISTS "importSource" TEXT,
  ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);

ALTER TABLE "EventureImportBatch"
  ADD COLUMN IF NOT EXISTS "rolledBackAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "rollbackMode" TEXT,
  ADD COLUMN IF NOT EXISTS "rollbackSummary" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "EventureImportRow"
  ADD COLUMN IF NOT EXISTS "rolledBackAt" TIMESTAMP(3);
