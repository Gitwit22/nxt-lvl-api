CREATE TABLE IF NOT EXISTS "EventureUnmatchedRevenue" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "programDomain" TEXT NOT NULL DEFAULT 'eventure',
  "eventId" TEXT NOT NULL,
  "importBatchId" TEXT NOT NULL,
  "importRowId" TEXT,
  "rowNumber" INTEGER,
  "sourceCompanyName" TEXT,
  "ticketBuyer" TEXT,
  "attendeeName" TEXT,
  "attendeeEmail" TEXT,
  "amount" DOUBLE PRECISION,
  "description" TEXT,
  "status" TEXT NOT NULL DEFAULT 'unmatched',
  "matchedParticipantId" TEXT,
  "notes" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EventureUnmatchedRevenue_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EventureUnmatchedRevenue_importBatchId_rowNumber_key"
  ON "EventureUnmatchedRevenue"("importBatchId", "rowNumber");

CREATE INDEX IF NOT EXISTS "EventureUnmatchedRevenue_organizationId_eventId_status_idx"
  ON "EventureUnmatchedRevenue"("organizationId", "eventId", "status");

CREATE INDEX IF NOT EXISTS "EventureUnmatchedRevenue_organizationId_eventId_createdAt_idx"
  ON "EventureUnmatchedRevenue"("organizationId", "eventId", "createdAt");

CREATE INDEX IF NOT EXISTS "EventureUnmatchedRevenue_organizationId_matchedParticipantId_idx"
  ON "EventureUnmatchedRevenue"("organizationId", "matchedParticipantId");
