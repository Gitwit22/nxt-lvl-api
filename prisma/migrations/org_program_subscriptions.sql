-- OrganizationProgramSubscription table
-- Replaces the old assignedProgramIds JSON blob on Organization.
-- Platform admin controls these rows. Launch checks status IN ('active', 'trialing').
-- Safe to re-run: uses IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "OrganizationProgramSubscription" (
  "id"                 TEXT NOT NULL DEFAULT gen_random_uuid()::text PRIMARY KEY,
  "organizationId"     TEXT NOT NULL,
  "programId"          TEXT NOT NULL,
  "status"             TEXT NOT NULL DEFAULT 'inactive',
  "subscriptionSource" TEXT NOT NULL DEFAULT 'manual',
  "startsAt"           TIMESTAMP(3),
  "endsAt"             TIMESTAMP(3),
  "seatLimit"          INTEGER,
  "notes"              TEXT NOT NULL DEFAULT '',
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OrgProgramSubscription_orgId_programId_unique"
    UNIQUE ("organizationId", "programId"),

  CONSTRAINT "OrgProgramSubscription_orgId_fk"
    FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id")
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "OrgProgramSubscription_orgId_idx"
  ON "OrganizationProgramSubscription" ("organizationId");

CREATE INDEX IF NOT EXISTS "OrgProgramSubscription_orgId_status_idx"
  ON "OrganizationProgramSubscription" ("organizationId", "status");

CREATE INDEX IF NOT EXISTS "OrgProgramSubscription_status_idx"
  ON "OrganizationProgramSubscription" ("status");

-- Seed subscriptions from legacy assignedProgramIds JSON blob (one-time migration).
-- This converts existing string-array entries into proper subscription rows.
-- Run this AFTER the CREATE TABLE above, and only once.
-- If you have no legacy data, this is a no-op.
--
-- INSERT INTO "OrganizationProgramSubscription" ("organizationId", "programId", "status", "subscriptionSource")
-- SELECT
--   o."id" AS "organizationId",
--   pid::text AS "programId",
--   'active' AS "status",
--   'comp' AS "subscriptionSource"
-- FROM
--   "Organization" o,
--   jsonb_array_elements_text(o."assignedProgramIds") AS pid
-- ON CONFLICT ("organizationId", "programId") DO NOTHING;
