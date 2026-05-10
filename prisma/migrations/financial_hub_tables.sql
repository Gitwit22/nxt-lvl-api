-- Financial Hub tables
-- Safe to re-run: statements use IF NOT EXISTS when possible.

CREATE TABLE IF NOT EXISTS "FinancialHubUserProfile" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "programDomain" TEXT NOT NULL DEFAULT 'financial-hub',
  "phone" TEXT,
  "title" TEXT,
  "defaultTimezone" TEXT NOT NULL DEFAULT 'America/New_York',
  "capabilities" JSONB NOT NULL DEFAULT '{}',
  "isInitialAdmin" BOOLEAN NOT NULL DEFAULT false,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "FinancialHubUserProfile_org_program_user_uniq"
  ON "FinancialHubUserProfile" ("organizationId", "programDomain", "userId");
CREATE INDEX IF NOT EXISTS "FinancialHubUserProfile_org_program_idx"
  ON "FinancialHubUserProfile" ("organizationId", "programDomain");
CREATE INDEX IF NOT EXISTS "FinancialHubUserProfile_org_program_initial_idx"
  ON "FinancialHubUserProfile" ("organizationId", "programDomain", "isInitialAdmin");

CREATE TABLE IF NOT EXISTS "FinanceIntakeRecord" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "programDomain" TEXT NOT NULL DEFAULT 'financial-hub',
  "sourceApp" TEXT NOT NULL,
  "sourceRecordId" TEXT NOT NULL,
  "sourceRecordType" TEXT NOT NULL,
  "sourceStatus" TEXT,
  "financeStatus" TEXT NOT NULL DEFAULT 'received',
  "title" TEXT NOT NULL,
  "description" TEXT,
  "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "transactionDate" TIMESTAMP(3),
  "payPeriodId" TEXT,
  "employeeId" TEXT,
  "volunteerId" TEXT,
  "programId" TEXT,
  "grantId" TEXT,
  "eventId" TEXT,
  "expenseId" TEXT,
  "timesheetId" TEXT,
  "fundingSourceId" TEXT,
  "submittedByUserId" TEXT,
  "operationallyApprovedByUserId" TEXT,
  "financeReviewedByUserId" TEXT,
  "financeReviewedAt" TIMESTAMP(3),
  "exportBatchId" TEXT,
  "postedAt" TIMESTAMP(3),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "attachments" JSONB NOT NULL DEFAULT '[]',
  "validationIssues" JSONB NOT NULL DEFAULT '[]',
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "FinanceIntakeRecord_org_source_uniq"
  ON "FinanceIntakeRecord" ("organizationId", "sourceApp", "sourceRecordId", "sourceRecordType");
CREATE INDEX IF NOT EXISTS "FinanceIntakeRecord_org_program_idx"
  ON "FinanceIntakeRecord" ("organizationId", "programDomain");
CREATE INDEX IF NOT EXISTS "FinanceIntakeRecord_org_status_idx"
  ON "FinanceIntakeRecord" ("organizationId", "financeStatus");
CREATE INDEX IF NOT EXISTS "FinanceIntakeRecord_org_source_type_idx"
  ON "FinanceIntakeRecord" ("organizationId", "sourceApp", "sourceRecordType");
CREATE INDEX IF NOT EXISTS "FinanceIntakeRecord_org_created_idx"
  ON "FinanceIntakeRecord" ("organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "FinanceIntakeRecord_source_app_record_idx"
  ON "FinanceIntakeRecord" ("sourceApp", "sourceRecordId");
CREATE INDEX IF NOT EXISTS "FinanceIntakeRecord_pay_period_idx"
  ON "FinanceIntakeRecord" ("payPeriodId");
CREATE INDEX IF NOT EXISTS "FinanceIntakeRecord_employee_idx"
  ON "FinanceIntakeRecord" ("employeeId");
CREATE INDEX IF NOT EXISTS "FinanceIntakeRecord_program_idx"
  ON "FinanceIntakeRecord" ("programId");
CREATE INDEX IF NOT EXISTS "FinanceIntakeRecord_grant_idx"
  ON "FinanceIntakeRecord" ("grantId");
CREATE INDEX IF NOT EXISTS "FinanceIntakeRecord_event_idx"
  ON "FinanceIntakeRecord" ("eventId");
