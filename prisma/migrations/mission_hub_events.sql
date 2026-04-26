-- Migration: Mission Hub Events
-- Creates MissionHubEvent table and adds eventId/eventName to MissionHubTimeEntry
-- and linkedEventId to MissionHubCalendarEntry.
-- Safe to re-run (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS "MissionHubEvent" (
  "id"                    TEXT NOT NULL,
  "organizationId"        TEXT NOT NULL,
  "userId"                TEXT NOT NULL,
  "programDomain"         TEXT NOT NULL DEFAULT 'mission-hub',
  "programId"             TEXT,
  "projectId"             TEXT,
  "grantId"               TEXT,
  "sponsorId"             TEXT,
  "fundraisingCampaignId" TEXT,
  "name"                  TEXT NOT NULL,
  "description"           TEXT NOT NULL DEFAULT '',
  "eventType"             TEXT,
  "status"                TEXT NOT NULL DEFAULT 'planned',
  "startDateTime"         TEXT NOT NULL,
  "endDateTime"           TEXT NOT NULL,
  "location"              TEXT,
  "isVirtual"             BOOLEAN NOT NULL DEFAULT FALSE,
  "meetingUrl"            TEXT,
  "calendarEventId"       TEXT,
  "assignedStaffIds"      JSONB NOT NULL DEFAULT '[]',
  "assignedVolunteerIds"  JSONB NOT NULL DEFAULT '[]',
  "budget"                DOUBLE PRECISION NOT NULL DEFAULT 0,
  "expectedRevenue"       DOUBLE PRECISION NOT NULL DEFAULT 0,
  "actualRevenue"         DOUBLE PRECISION NOT NULL DEFAULT 0,
  "billable"              BOOLEAN NOT NULL DEFAULT FALSE,
  "billingCode"           TEXT,
  "fundingSourceType"     TEXT,
  "fundingSourceId"       TEXT,
  "isActive"              BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MissionHubEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MissionHubEvent_orgUserDomain_idx"
  ON "MissionHubEvent"("organizationId", "userId", "programDomain");

CREATE INDEX IF NOT EXISTS "MissionHubEvent_orgUserDomainStatus_idx"
  ON "MissionHubEvent"("organizationId", "userId", "programDomain", "status");

CREATE INDEX IF NOT EXISTS "MissionHubEvent_orgUserDomainProgram_idx"
  ON "MissionHubEvent"("organizationId", "userId", "programDomain", "programId");

CREATE INDEX IF NOT EXISTS "MissionHubEvent_orgUserDomainProject_idx"
  ON "MissionHubEvent"("organizationId", "userId", "programDomain", "projectId");

CREATE INDEX IF NOT EXISTS "MissionHubEvent_orgUserDomainStart_idx"
  ON "MissionHubEvent"("organizationId", "userId", "programDomain", "startDateTime");

-- Add eventId/eventName to MissionHubTimeEntry if not already present
ALTER TABLE "MissionHubTimeEntry"
  ADD COLUMN IF NOT EXISTS "eventId"   TEXT,
  ADD COLUMN IF NOT EXISTS "eventName" TEXT;

-- Add linkedEventId to MissionHubCalendarEntry if not already present
ALTER TABLE "MissionHubCalendarEntry"
  ADD COLUMN IF NOT EXISTS "linkedEventId" TEXT;

-- Ensure MissionHubProject has fundraisingCampaignId for project funding linkage
ALTER TABLE "MissionHubProject"
  ADD COLUMN IF NOT EXISTS "fundraisingCampaignId" TEXT;
