-- Mission Hub Tables
-- Safe to re-run: all statements use IF NOT EXISTS.
-- Run this in the Neon SQL Editor (copy the full block).

-- Programs
CREATE TABLE IF NOT EXISTS "MissionHubProgram" (
  "id"              TEXT NOT NULL DEFAULT gen_random_uuid()::text PRIMARY KEY,
  "organizationId"  TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "category"        TEXT NOT NULL DEFAULT '',
  "manager"         TEXT NOT NULL DEFAULT '',
  "status"          TEXT NOT NULL DEFAULT 'Active',
  "startDate"       TEXT NOT NULL DEFAULT '',
  "endDate"         TEXT,
  "budget"          TEXT NOT NULL DEFAULT '',
  "budgetAmount"    DOUBLE PRECISION NOT NULL DEFAULT 0,
  "progress"        INTEGER NOT NULL DEFAULT 0,
  "description"     TEXT NOT NULL DEFAULT '',
  "targetAudience"  TEXT NOT NULL DEFAULT '',
  "team"            JSONB NOT NULL DEFAULT '[]',
  "timeEntries"     JSONB NOT NULL DEFAULT '[]',
  "budgetItems"     JSONB NOT NULL DEFAULT '[]',
  "supporters"      JSONB NOT NULL DEFAULT '[]',
  "sponsors"        JSONB NOT NULL DEFAULT '[]',
  "documents"       JSONB NOT NULL DEFAULT '[]',
  "tasks"           JSONB NOT NULL DEFAULT '[]',
  "outcomes"        JSONB NOT NULL DEFAULT '[]',
  "isActive"        BOOLEAN NOT NULL DEFAULT true,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "MissionHubProgram_orgUser_idx"
  ON "MissionHubProgram" ("organizationId", "userId");
CREATE INDEX IF NOT EXISTS "MissionHubProgram_orgUser_status_idx"
  ON "MissionHubProgram" ("organizationId", "userId", "status");

-- Grants
CREATE TABLE IF NOT EXISTS "MissionHubGrant" (
  "id"                 TEXT NOT NULL DEFAULT gen_random_uuid()::text PRIMARY KEY,
  "organizationId"     TEXT NOT NULL,
  "userId"             TEXT NOT NULL,
  "grantName"          TEXT NOT NULL,
  "fundingSource"      TEXT NOT NULL DEFAULT '',
  "amountAwarded"      DOUBLE PRECISION NOT NULL DEFAULT 0,
  "startDate"          TEXT NOT NULL DEFAULT '',
  "endDate"            TEXT,
  "status"             TEXT NOT NULL DEFAULT 'Active',
  "grantManager"       TEXT NOT NULL DEFAULT '',
  "linkedPrograms"     JSONB NOT NULL DEFAULT '[]',
  "reportingStatus"    TEXT NOT NULL DEFAULT '',
  "requirements"       JSONB NOT NULL DEFAULT '[]',
  "budgetAllocation"   JSONB NOT NULL DEFAULT '[]',
  "reportingDeadlines" JSONB NOT NULL DEFAULT '[]',
  "isActive"           BOOLEAN NOT NULL DEFAULT true,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "MissionHubGrant_orgUser_idx"
  ON "MissionHubGrant" ("organizationId", "userId");
CREATE INDEX IF NOT EXISTS "MissionHubGrant_orgUser_status_idx"
  ON "MissionHubGrant" ("organizationId", "userId", "status");

-- Expenses
CREATE TABLE IF NOT EXISTS "MissionHubExpense" (
  "id"              TEXT NOT NULL DEFAULT gen_random_uuid()::text PRIMARY KEY,
  "organizationId"  TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "expenseName"     TEXT NOT NULL,
  "amount"          DOUBLE PRECISION NOT NULL DEFAULT 0,
  "date"            TEXT NOT NULL DEFAULT '',
  "category"        TEXT NOT NULL DEFAULT '',
  "type"            TEXT NOT NULL DEFAULT '',
  "linkedProgramId" TEXT,
  "linkedProgram"   TEXT,
  "linkedGrant"     TEXT,
  "linkedCampaign"  TEXT,
  "fundingSource"   TEXT,
  "notes"           TEXT NOT NULL DEFAULT '',
  "approvalStatus"  TEXT NOT NULL DEFAULT 'Pending',
  "recurring"       BOOLEAN NOT NULL DEFAULT false,
  "isActive"        BOOLEAN NOT NULL DEFAULT true,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "MissionHubExpense_orgUser_idx"
  ON "MissionHubExpense" ("organizationId", "userId");
CREATE INDEX IF NOT EXISTS "MissionHubExpense_orgUser_category_idx"
  ON "MissionHubExpense" ("organizationId", "userId", "category");
CREATE INDEX IF NOT EXISTS "MissionHubExpense_orgUser_approval_idx"
  ON "MissionHubExpense" ("organizationId", "userId", "approvalStatus");

-- Sponsors
CREATE TABLE IF NOT EXISTS "MissionHubSponsor" (
  "id"                 TEXT NOT NULL DEFAULT gen_random_uuid()::text PRIMARY KEY,
  "organizationId"     TEXT NOT NULL,
  "userId"             TEXT NOT NULL,
  "sponsorType"        TEXT NOT NULL DEFAULT '',
  "organizationName"   TEXT NOT NULL,
  "contactName"        TEXT NOT NULL DEFAULT '',
  "email"              TEXT NOT NULL DEFAULT '',
  "phone"              TEXT NOT NULL DEFAULT '',
  "contributionAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "contributionType"   TEXT NOT NULL DEFAULT '',
  "paymentStatus"      TEXT NOT NULL DEFAULT '',
  "status"             TEXT NOT NULL DEFAULT 'Active',
  "notes"              TEXT NOT NULL DEFAULT '',
  "linkedPrograms"     JSONB NOT NULL DEFAULT '[]',
  "linkedCampaigns"    JSONB NOT NULL DEFAULT '[]',
  "linkedItems"        JSONB NOT NULL DEFAULT '[]',
  "isActive"           BOOLEAN NOT NULL DEFAULT true,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "MissionHubSponsor_orgUser_idx"
  ON "MissionHubSponsor" ("organizationId", "userId");
CREATE INDEX IF NOT EXISTS "MissionHubSponsor_orgUser_status_idx"
  ON "MissionHubSponsor" ("organizationId", "userId", "status");

-- Fundraising Campaigns
CREATE TABLE IF NOT EXISTS "MissionHubCampaign" (
  "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "category"       TEXT NOT NULL DEFAULT 'Event',
  "status"         TEXT NOT NULL DEFAULT 'Planning',
  "owner"          TEXT NOT NULL DEFAULT '',
  "startDate"      TEXT NOT NULL DEFAULT '',
  "endDate"        TEXT,
  "goalAmount"     DOUBLE PRECISION NOT NULL DEFAULT 0,
  "linkedPrograms" JSONB NOT NULL DEFAULT '[]',
  "tiers"          JSONB NOT NULL DEFAULT '[]',
  "items"          JSONB NOT NULL DEFAULT '[]',
  "donations"      JSONB NOT NULL DEFAULT '[]',
  "events"         JSONB NOT NULL DEFAULT '[]',
  "expenses"       JSONB NOT NULL DEFAULT '[]',
  "documents"      JSONB NOT NULL DEFAULT '[]',
  "isActive"       BOOLEAN NOT NULL DEFAULT true,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "MissionHubCampaign_orgUser_idx"
  ON "MissionHubCampaign" ("organizationId", "userId");
CREATE INDEX IF NOT EXISTS "MissionHubCampaign_orgUser_status_idx"
  ON "MissionHubCampaign" ("organizationId", "userId", "status");

-- Personnel
CREATE TABLE IF NOT EXISTS "MissionHubPersonnel" (
  "id"               TEXT NOT NULL DEFAULT gen_random_uuid()::text PRIMARY KEY,
  "organizationId"   TEXT NOT NULL,
  "userId"           TEXT NOT NULL,
  "firstName"        TEXT NOT NULL,
  "lastName"         TEXT NOT NULL,
  "email"            TEXT NOT NULL DEFAULT '',
  "phone"            TEXT NOT NULL DEFAULT '',
  "title"            TEXT NOT NULL DEFAULT '',
  "department"       TEXT NOT NULL DEFAULT '',
  "type"             TEXT NOT NULL DEFAULT 'Staff',
  "role"             TEXT NOT NULL DEFAULT 'Admin',
  "status"           TEXT NOT NULL DEFAULT 'Active',
  "accessLevel"      TEXT NOT NULL DEFAULT 'Basic',
  "assignedPrograms" JSONB NOT NULL DEFAULT '[]',
  "assignedGrants"   JSONB NOT NULL DEFAULT '[]',
  "notes"            TEXT NOT NULL DEFAULT '',
  "isActive"         BOOLEAN NOT NULL DEFAULT true,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "MissionHubPersonnel_orgUser_idx"
  ON "MissionHubPersonnel" ("organizationId", "userId");
CREATE INDEX IF NOT EXISTS "MissionHubPersonnel_orgUser_status_idx"
  ON "MissionHubPersonnel" ("organizationId", "userId", "status");
CREATE INDEX IF NOT EXISTS "MissionHubPersonnel_orgUser_type_idx"
  ON "MissionHubPersonnel" ("organizationId", "userId", "type");

-- Calendar Entries
CREATE TABLE IF NOT EXISTS "MissionHubCalendarEntry" (
  "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "title"          TEXT NOT NULL,
  "date"           TEXT NOT NULL,
  "type"           TEXT NOT NULL DEFAULT '',
  "description"    TEXT NOT NULL DEFAULT '',
  "linkedEntity"   TEXT,
  "linkedEntityId" TEXT,
  "isActive"       BOOLEAN NOT NULL DEFAULT true,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "MissionHubCalendarEntry_orgUser_idx"
  ON "MissionHubCalendarEntry" ("organizationId", "userId");
CREATE INDEX IF NOT EXISTS "MissionHubCalendarEntry_orgUser_date_idx"
  ON "MissionHubCalendarEntry" ("organizationId", "userId", "date");

-- Saved Reports
CREATE TABLE IF NOT EXISTS "MissionHubSavedReport" (
  "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "description"    TEXT NOT NULL DEFAULT '',
  "config"         JSONB NOT NULL DEFAULT '{}',
  "isFavorite"     BOOLEAN NOT NULL DEFAULT false,
  "lastRun"        TEXT,
  "isActive"       BOOLEAN NOT NULL DEFAULT true,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "MissionHubSavedReport_orgUser_idx"
  ON "MissionHubSavedReport" ("organizationId", "userId");
CREATE INDEX IF NOT EXISTS "MissionHubSavedReport_orgUser_fav_idx"
  ON "MissionHubSavedReport" ("organizationId", "userId", "isFavorite");
