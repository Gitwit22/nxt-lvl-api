-- Mission Hub timesheet submission workflow
-- Safe to re-run: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS used.

ALTER TABLE "MissionHubTimeEntry"
  ADD COLUMN IF NOT EXISTS "personId" TEXT,
  ADD COLUMN IF NOT EXISTS "programId" TEXT,
  ADD COLUMN IF NOT EXISTS "grantId" TEXT,
  ADD COLUMN IF NOT EXISTS "sponsorId" TEXT,
  ADD COLUMN IF NOT EXISTS "fundraisingCampaignId" TEXT,
  ADD COLUMN IF NOT EXISTS "fundingSourceType" TEXT,
  ADD COLUMN IF NOT EXISTS "fundingSourceId" TEXT,
  ADD COLUMN IF NOT EXISTS "timesheetSubmissionId" TEXT,
  ADD COLUMN IF NOT EXISTS "billable" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "payable" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "volunteer" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "hourlyRate" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "laborValue" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "submittedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "processedAt" TIMESTAMP(3);

UPDATE "MissionHubTimeEntry"
SET "status" = CASE lower(coalesce("status", ''))
  WHEN 'draft' THEN 'draft'
  WHEN 'submitted' THEN 'submitted'
  WHEN 'approved' THEN 'approved'
  WHEN 'rejected' THEN 'rejected'
  WHEN 'finance review' THEN 'finance_review'
  WHEN 'finance_review' THEN 'finance_review'
  WHEN 'changes requested' THEN 'changes_requested'
  WHEN 'changes_requested' THEN 'changes_requested'
  WHEN 'processed' THEN 'processed'
  WHEN 'processed/paid' THEN 'processed'
  WHEN 'archived' THEN 'archived'
  ELSE 'draft'
END;

CREATE INDEX IF NOT EXISTS "MissionHubTimeEntry_org_domain_submission_idx"
  ON "MissionHubTimeEntry" ("organizationId", "programDomain", "timesheetSubmissionId");

CREATE TABLE IF NOT EXISTS "MissionHubTimesheetSubmission" (
  "id"                      TEXT NOT NULL DEFAULT gen_random_uuid()::text PRIMARY KEY,
  "organizationId"          TEXT NOT NULL,
  "programDomain"           TEXT NOT NULL DEFAULT 'mission-hub',
  "submittedByPersonId"     TEXT,
  "submittedByUserId"       TEXT NOT NULL,
  "periodStart"             TEXT NOT NULL,
  "periodEnd"               TEXT NOT NULL,
  "status"                  TEXT NOT NULL DEFAULT 'draft',
  "totalHours"              DOUBLE PRECISION NOT NULL DEFAULT 0,
  "payableHours"            DOUBLE PRECISION NOT NULL DEFAULT 0,
  "volunteerHours"          DOUBLE PRECISION NOT NULL DEFAULT 0,
  "billableHours"           DOUBLE PRECISION NOT NULL DEFAULT 0,
  "estimatedPayableAmount"  DOUBLE PRECISION NOT NULL DEFAULT 0,
  "estimatedBillableAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "grantLaborValue"         DOUBLE PRECISION,
  "volunteerMatchValue"     DOUBLE PRECISION,
  "submittedAt"             TIMESTAMP(3),
  "reviewedByUserId"        TEXT,
  "reviewedAt"              TIMESTAMP(3),
  "financeNotes"            TEXT,
  "rejectionReason"         TEXT,
  "changeRequestReason"     TEXT,
  "processedAt"             TIMESTAMP(3),
  "isActive"                BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "MissionHubTimesheetSubmission_org_domain_idx"
  ON "MissionHubTimesheetSubmission" ("organizationId", "programDomain");

CREATE INDEX IF NOT EXISTS "MissionHubTimesheetSubmission_org_domain_status_idx"
  ON "MissionHubTimesheetSubmission" ("organizationId", "programDomain", "status");

CREATE INDEX IF NOT EXISTS "MissionHubTimesheetSubmission_org_submitter_idx"
  ON "MissionHubTimesheetSubmission" ("organizationId", "submittedByUserId", "programDomain");

CREATE TABLE IF NOT EXISTS "MissionHubTimesheetApprovalLog" (
  "id"                     TEXT NOT NULL DEFAULT gen_random_uuid()::text PRIMARY KEY,
  "organizationId"         TEXT NOT NULL,
  "programDomain"          TEXT NOT NULL DEFAULT 'mission-hub',
  "timesheetSubmissionId"  TEXT NOT NULL,
  "action"                 TEXT NOT NULL,
  "actorUserId"            TEXT NOT NULL,
  "actorPersonId"          TEXT,
  "actorRole"              TEXT,
  "note"                   TEXT,
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "MissionHubTimesheetApprovalLog_submission_idx"
  ON "MissionHubTimesheetApprovalLog" ("organizationId", "programDomain", "timesheetSubmissionId", "createdAt");

CREATE INDEX IF NOT EXISTS "MissionHubTimesheetApprovalLog_actor_idx"
  ON "MissionHubTimesheetApprovalLog" ("organizationId", "actorUserId", "programDomain");
