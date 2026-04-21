-- Mission Hub Tasks + Time Entries
-- Safe to re-run: all statements use IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "MissionHubTask" (
  "id"              TEXT NOT NULL DEFAULT gen_random_uuid()::text PRIMARY KEY,
  "organizationId"  TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "programDomain"   TEXT NOT NULL DEFAULT 'mission-hub',
  "title"           TEXT NOT NULL,
  "description"     TEXT NOT NULL DEFAULT '',
  "assignedTo"      TEXT NOT NULL DEFAULT '',
  "owner"           TEXT NOT NULL DEFAULT '',
  "dueDate"         TEXT NOT NULL DEFAULT '',
  "priority"        TEXT NOT NULL DEFAULT 'Medium',
  "status"          TEXT NOT NULL DEFAULT 'To Do',
  "linkedProgramId" TEXT,
  "linkedProgram"   TEXT,
  "isActive"        BOOLEAN NOT NULL DEFAULT true,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "MissionHubTask_orgUser_domain_idx"
  ON "MissionHubTask" ("organizationId", "userId", "programDomain");
CREATE INDEX IF NOT EXISTS "MissionHubTask_orgUser_domain_status_idx"
  ON "MissionHubTask" ("organizationId", "userId", "programDomain", "status");
CREATE INDEX IF NOT EXISTS "MissionHubTask_orgUser_domain_dueDate_idx"
  ON "MissionHubTask" ("organizationId", "userId", "programDomain", "dueDate");

CREATE TABLE IF NOT EXISTS "MissionHubTimeEntry" (
  "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "programDomain"  TEXT NOT NULL DEFAULT 'mission-hub',
  "person"         TEXT NOT NULL,
  "initials"       TEXT NOT NULL DEFAULT '',
  "date"           TEXT NOT NULL,
  "startTime"      TEXT NOT NULL DEFAULT '',
  "endTime"        TEXT NOT NULL DEFAULT '',
  "hours"          DOUBLE PRECISION NOT NULL DEFAULT 0,
  "projectId"      TEXT,
  "projectName"    TEXT,
  "linkedGrant"    TEXT,
  "linkedSponsor"  TEXT,
  "notes"          TEXT NOT NULL DEFAULT '',
  "status"         TEXT NOT NULL DEFAULT 'Draft',
  "isActive"       BOOLEAN NOT NULL DEFAULT true,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "MissionHubTimeEntry_orgUser_domain_idx"
  ON "MissionHubTimeEntry" ("organizationId", "userId", "programDomain");
CREATE INDEX IF NOT EXISTS "MissionHubTimeEntry_orgUser_domain_status_idx"
  ON "MissionHubTimeEntry" ("organizationId", "userId", "programDomain", "status");
CREATE INDEX IF NOT EXISTS "MissionHubTimeEntry_orgUser_domain_date_idx"
  ON "MissionHubTimeEntry" ("organizationId", "userId", "programDomain", "date");
