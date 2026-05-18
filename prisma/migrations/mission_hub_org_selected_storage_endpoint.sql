-- Mission Hub org-wide selected storage endpoint
-- Safe to re-run.

ALTER TABLE "MissionHubOrganizationSettings"
ADD COLUMN IF NOT EXISTS "selectedStorageEndpointId" TEXT;
