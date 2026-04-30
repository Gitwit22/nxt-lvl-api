-- Mission Hub: Password reset token columns on User
-- Safe to re-run: uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS pattern.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "passwordResetTokenHash" TEXT,
  ADD COLUMN IF NOT EXISTS "passwordResetExpiresAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "User_passwordResetTokenHash_idx"
  ON "User" ("passwordResetTokenHash")
  WHERE "passwordResetTokenHash" IS NOT NULL;
