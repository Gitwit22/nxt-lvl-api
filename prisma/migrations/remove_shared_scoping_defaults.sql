-- Remove app-specific defaults from shared/scoped tables.
-- Safe to re-run: DROP DEFAULT is a no-op if no default is set.

ALTER TABLE "ProgramStorageSettings"
  ALTER COLUMN "programDomain" DROP DEFAULT;

ALTER TABLE "Program"
  ALTER COLUMN "programDomain" DROP DEFAULT;

ALTER TABLE "Document"
  ALTER COLUMN "organizationId" DROP DEFAULT,
  ALTER COLUMN "programDomain" DROP DEFAULT;

ALTER TABLE "ProcessingJob"
  ALTER COLUMN "organizationId" DROP DEFAULT,
  ALTER COLUMN "programDomain" DROP DEFAULT;
