-- Mission Hub Projects
-- Safe to re-run: all statements use IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "MissionHubProject" (
  "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "programDomain"  TEXT NOT NULL DEFAULT 'mission-hub',
  "programId"      TEXT,
  "name"           TEXT NOT NULL,
  "description"    TEXT NOT NULL DEFAULT '',
  "status"         TEXT NOT NULL DEFAULT 'active',
  "managerId"      TEXT,
  "managerName"    TEXT,
  "grantId"        TEXT,
  "grantName"      TEXT,
  "sponsorId"      TEXT,
  "sponsorName"    TEXT,
  "fundraisingCampaignId" TEXT,
  "budget"         DOUBLE PRECISION NOT NULL DEFAULT 0,
  "startDate"      TEXT,
  "endDate"        TEXT,
  "isActive"       BOOLEAN NOT NULL DEFAULT true,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "MissionHubProject_orgUser_domain_idx"
  ON "MissionHubProject" ("organizationId", "userId", "programDomain");
CREATE INDEX IF NOT EXISTS "MissionHubProject_orgUser_domain_status_idx"
  ON "MissionHubProject" ("organizationId", "userId", "programDomain", "status");
CREATE INDEX IF NOT EXISTS "MissionHubProject_orgUser_domain_program_idx"
  ON "MissionHubProject" ("organizationId", "userId", "programDomain", "programId");
CREATE INDEX IF NOT EXISTS "MissionHubProject_org_user_domain_campaign_idx"
  ON "MissionHubProject"("organizationId", "userId", "programDomain", "fundraisingCampaignId");
