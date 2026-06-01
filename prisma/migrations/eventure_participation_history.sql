CREATE TABLE IF NOT EXISTS "EventParticipationHistory" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "programDomain" TEXT NOT NULL DEFAULT 'eventure',
  "eventId" TEXT,
  "sponsorOrganizationId" TEXT,
  "sponsorContactId" TEXT,
  "sourceEventName" TEXT,
  "sourceEventYear" INTEGER,
  "rawCompanyName" TEXT,
  "rawContactName" TEXT,
  "rawRole" TEXT,
  "rawPackage" TEXT,
  "rawPaymentStatus" TEXT,
  "participationType" TEXT NOT NULL DEFAULT 'unknown',
  "sponsorshipPackage" TEXT,
  "amountCommitted" DECIMAL(18,2),
  "amountPaid" DECIMAL(18,2),
  "paymentStatus" TEXT,
  "flight" TEXT,
  "slot" TEXT,
  "notes" TEXT,
  "sourceImportBatchId" TEXT,
  "sourceSheetName" TEXT,
  "sourceRowNumber" INTEGER,
  "sourceRowHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EventParticipationHistory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "EventParticipationHistory_organizationId_idx"
  ON "EventParticipationHistory"("organizationId");

CREATE INDEX IF NOT EXISTS "EventParticipationHistory_eventId_idx"
  ON "EventParticipationHistory"("eventId");

CREATE INDEX IF NOT EXISTS "EventParticipationHistory_sponsorOrganizationId_idx"
  ON "EventParticipationHistory"("sponsorOrganizationId");

CREATE INDEX IF NOT EXISTS "EventParticipationHistory_sponsorContactId_idx"
  ON "EventParticipationHistory"("sponsorContactId");

CREATE INDEX IF NOT EXISTS "EventParticipationHistory_sourceImportBatchId_idx"
  ON "EventParticipationHistory"("sourceImportBatchId");

CREATE INDEX IF NOT EXISTS "EventParticipationHistory_sourceEventYear_idx"
  ON "EventParticipationHistory"("sourceEventYear");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'EventParticipationHistory_eventId_fkey'
  ) THEN
    ALTER TABLE "EventParticipationHistory"
      ADD CONSTRAINT "EventParticipationHistory_eventId_fkey"
      FOREIGN KEY ("eventId") REFERENCES "EventureEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'EventParticipationHistory_sponsorOrganizationId_fkey'
  ) THEN
    ALTER TABLE "EventParticipationHistory"
      ADD CONSTRAINT "EventParticipationHistory_sponsorOrganizationId_fkey"
      FOREIGN KEY ("sponsorOrganizationId") REFERENCES "EventureSponsorOrganization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'EventParticipationHistory_sponsorContactId_fkey'
  ) THEN
    ALTER TABLE "EventParticipationHistory"
      ADD CONSTRAINT "EventParticipationHistory_sponsorContactId_fkey"
      FOREIGN KEY ("sponsorContactId") REFERENCES "EventureSponsorContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;
