-- ============================================================
-- Timeflow Project Bills
-- Run this in the Neon SQL Editor to add fixed/manual project billing.
-- Safe to re-run: all statements use IF NOT EXISTS.
-- ============================================================

CREATE TABLE IF NOT EXISTS "TimeflowProjectBill" (
  "id"             TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
  "organizationId" TEXT         NOT NULL,
  "userId"         TEXT         NOT NULL,
  "projectId"      TEXT         NOT NULL,
  "clientId"       TEXT         NOT NULL,
  "title"          TEXT         NOT NULL,
  "amount"         DOUBLE PRECISION NOT NULL DEFAULT 0,
  "issueDate"      TEXT         NOT NULL,
  "dueDate"        TEXT,
  "notes"          TEXT         NOT NULL DEFAULT '',
  "status"         TEXT         NOT NULL DEFAULT 'issued',
  "paidAt"         TIMESTAMP(3),
  "voidedAt"       TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TimeflowProjectBill_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TimeflowProjectBill_organizationId_userId_idx"
  ON "TimeflowProjectBill" ("organizationId", "userId");

CREATE INDEX IF NOT EXISTS "TimeflowProjectBill_organizationId_userId_projectId_idx"
  ON "TimeflowProjectBill" ("organizationId", "userId", "projectId");

CREATE INDEX IF NOT EXISTS "TimeflowProjectBill_organizationId_userId_clientId_idx"
  ON "TimeflowProjectBill" ("organizationId", "userId", "clientId");

CREATE INDEX IF NOT EXISTS "TimeflowProjectBill_organizationId_userId_status_idx"
  ON "TimeflowProjectBill" ("organizationId", "userId", "status");

CREATE INDEX IF NOT EXISTS "TimeflowProjectBill_organizationId_userId_issueDate_idx"
  ON "TimeflowProjectBill" ("organizationId", "userId", "issueDate");
