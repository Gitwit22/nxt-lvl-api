-- Additive: per-business profile/branding for TimeFlow workspaces.
-- Nullable, so existing rows are unaffected.
ALTER TABLE "TimeflowWorkspaceMeta" ADD COLUMN IF NOT EXISTS "businessProfile" JSONB;
