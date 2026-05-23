-- Add workspace/source fields for time entries and create time-off request storage.

ALTER TABLE "TimeflowTimeEntry" ADD COLUMN IF NOT EXISTS "workspaceId" TEXT;
ALTER TABLE "TimeflowTimeEntry" ADD COLUMN IF NOT EXISTS "sourceType" TEXT;
ALTER TABLE "TimeflowTimeEntry" ADD COLUMN IF NOT EXISTS "sourceRequestId" TEXT;

-- Backfill workspace scope for existing records.
UPDATE "TimeflowTimeEntry"
SET "workspaceId" = "organizationId"
WHERE "workspaceId" IS NULL;

CREATE INDEX IF NOT EXISTS "TimeflowTimeEntry_organizationId_userId_workspaceId_idx"
  ON "TimeflowTimeEntry" ("organizationId", "userId", "workspaceId");

CREATE TABLE IF NOT EXISTS "TimeflowTimeOffRequest" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "leaveType" TEXT NOT NULL,
  "startDate" TEXT NOT NULL,
  "endDate" TEXT NOT NULL,
  "hoursRequested" DOUBLE PRECISION NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "reason" TEXT,
  "reviewerNote" TEXT,
  "requestedBy" TEXT NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "generatedTimeEntryIds" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TimeflowTimeOffRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TimeflowTimeOffRequest_organizationId_workspaceId_idx"
  ON "TimeflowTimeOffRequest" ("organizationId", "workspaceId");

CREATE INDEX IF NOT EXISTS "TimeflowTimeOffRequest_organizationId_employeeId_idx"
  ON "TimeflowTimeOffRequest" ("organizationId", "employeeId");

CREATE INDEX IF NOT EXISTS "TimeflowTimeOffRequest_organizationId_status_idx"
  ON "TimeflowTimeOffRequest" ("organizationId", "status");

CREATE INDEX IF NOT EXISTS "TimeflowTimeOffRequest_organizationId_startDate_endDate_idx"
  ON "TimeflowTimeOffRequest" ("organizationId", "startDate", "endDate");
