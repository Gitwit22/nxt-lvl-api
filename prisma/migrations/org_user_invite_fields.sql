-- Migration: org_user_invite_fields
-- Adds invitedById to User for audit trail of who created an org user account.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "invitedById" TEXT;
