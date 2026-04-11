-- ============================================================
-- Timeflow Tables
-- Run this in the Neon SQL Editor to create all Timeflow tables.
-- Safe to re-run: all statements use IF NOT EXISTS.
-- ============================================================

CREATE TABLE IF NOT EXISTS "TimeflowSettings" (
  "id"                   TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "organizationId"       TEXT        NOT NULL,
  "userId"               TEXT        NOT NULL,
  "businessName"         TEXT        NOT NULL DEFAULT '',
  "defaultClientId"      TEXT,
  "invoiceNotes"         TEXT        NOT NULL DEFAULT '',
  "paymentInstructions"  TEXT        NOT NULL DEFAULT '',
  "invoiceLogoDataUrl"   TEXT,
  "invoiceBannerDataUrl" TEXT,
  "companyViewerAccess"  BOOLEAN     NOT NULL DEFAULT false,
  "emailTemplate"        TEXT        NOT NULL DEFAULT '',
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TimeflowSettings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TimeflowSettings_organizationId_userId_key"
  ON "TimeflowSettings" ("organizationId", "userId");

CREATE INDEX IF NOT EXISTS "TimeflowSettings_organizationId_userId_idx"
  ON "TimeflowSettings" ("organizationId", "userId");

-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "TimeflowClient" (
  "id"                   TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "organizationId"       TEXT        NOT NULL,
  "userId"               TEXT        NOT NULL,
  "name"                 TEXT        NOT NULL,
  "contactName"          TEXT,
  "contactEmail"         TEXT,
  "contacts"             JSONB       NOT NULL DEFAULT '[]',
  "hourlyRate"           DOUBLE PRECISION,
  "companyViewerEnabled" BOOLEAN     NOT NULL DEFAULT false,
  "isActive"             BOOLEAN     NOT NULL DEFAULT true,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TimeflowClient_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TimeflowClient_organizationId_userId_idx"
  ON "TimeflowClient" ("organizationId", "userId");

CREATE INDEX IF NOT EXISTS "TimeflowClient_organizationId_userId_isActive_idx"
  ON "TimeflowClient" ("organizationId", "userId", "isActive");

-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "TimeflowProject" (
  "id"             TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "organizationId" TEXT        NOT NULL,
  "userId"         TEXT        NOT NULL,
  "clientId"       TEXT        NOT NULL,
  "name"           TEXT        NOT NULL,
  "status"         TEXT        NOT NULL DEFAULT 'active',
  "description"    TEXT        NOT NULL DEFAULT '',
  "billingType"    TEXT        NOT NULL DEFAULT 'hourly_uncapped',
  "hourlyRate"     DOUBLE PRECISION NOT NULL DEFAULT 0,
  "maxPayoutCap"   DOUBLE PRECISION NOT NULL DEFAULT 0,
  "capHandling"    TEXT        NOT NULL DEFAULT 'allow_overage',
  "startDate"      TEXT        NOT NULL,
  "endDate"        TEXT,
  "notes"          TEXT        NOT NULL DEFAULT '',
  "isActive"       BOOLEAN     NOT NULL DEFAULT true,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TimeflowProject_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TimeflowProject_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "TimeflowClient"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "TimeflowProject_organizationId_userId_idx"
  ON "TimeflowProject" ("organizationId", "userId");

CREATE INDEX IF NOT EXISTS "TimeflowProject_organizationId_userId_clientId_idx"
  ON "TimeflowProject" ("organizationId", "userId", "clientId");

CREATE INDEX IF NOT EXISTS "TimeflowProject_organizationId_userId_status_idx"
  ON "TimeflowProject" ("organizationId", "userId", "status");

-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "TimeflowTimeEntry" (
  "id"             TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "organizationId" TEXT        NOT NULL,
  "userId"         TEXT        NOT NULL,
  "clientId"       TEXT        NOT NULL,
  "projectId"      TEXT,
  "date"           TEXT        NOT NULL,
  "startTime"      TEXT        NOT NULL,
  "endTime"        TEXT,
  "durationHours"  DOUBLE PRECISION NOT NULL DEFAULT 0,
  "billingRate"    DOUBLE PRECISION,
  "billable"       BOOLEAN     NOT NULL DEFAULT true,
  "invoiced"       BOOLEAN     NOT NULL DEFAULT false,
  "invoiceId"      TEXT,
  "notes"          TEXT        NOT NULL DEFAULT '',
  "status"         TEXT        NOT NULL DEFAULT 'completed',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TimeflowTimeEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TimeflowTimeEntry_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "TimeflowClient"("id") ON DELETE CASCADE,
  CONSTRAINT "TimeflowTimeEntry_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "TimeflowProject"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "TimeflowTimeEntry_organizationId_userId_idx"
  ON "TimeflowTimeEntry" ("organizationId", "userId");

CREATE INDEX IF NOT EXISTS "TimeflowTimeEntry_organizationId_userId_clientId_idx"
  ON "TimeflowTimeEntry" ("organizationId", "userId", "clientId");

CREATE INDEX IF NOT EXISTS "TimeflowTimeEntry_organizationId_userId_date_idx"
  ON "TimeflowTimeEntry" ("organizationId", "userId", "date");

CREATE INDEX IF NOT EXISTS "TimeflowTimeEntry_organizationId_userId_invoiced_idx"
  ON "TimeflowTimeEntry" ("organizationId", "userId", "invoiced");

CREATE INDEX IF NOT EXISTS "TimeflowTimeEntry_organizationId_userId_status_idx"
  ON "TimeflowTimeEntry" ("organizationId", "userId", "status");

-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "TimeflowInvoice" (
  "id"             TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "organizationId" TEXT        NOT NULL,
  "userId"         TEXT        NOT NULL,
  "clientId"       TEXT        NOT NULL,
  "periodStart"    TEXT        NOT NULL,
  "periodEnd"      TEXT        NOT NULL,
  "billingMode"    TEXT        NOT NULL DEFAULT 'outstanding',
  "rangeStart"     TEXT,
  "rangeEnd"       TEXT,
  "grouping"       TEXT        NOT NULL DEFAULT 'none',
  "dueDate"        TEXT        NOT NULL,
  "entryIds"       JSONB       NOT NULL DEFAULT '[]',
  "timeEntryIds"   JSONB       NOT NULL DEFAULT '[]',
  "lineItems"      JSONB       NOT NULL DEFAULT '[]',
  "projectIds"     JSONB       NOT NULL DEFAULT '[]',
  "totalHours"     DOUBLE PRECISION NOT NULL DEFAULT 0,
  "hourlyRate"     DOUBLE PRECISION NOT NULL DEFAULT 0,
  "subtotal"       DOUBLE PRECISION NOT NULL DEFAULT 0,
  "taxRate"        DOUBLE PRECISION NOT NULL DEFAULT 0,
  "taxAmount"      DOUBLE PRECISION NOT NULL DEFAULT 0,
  "totalAmount"    DOUBLE PRECISION NOT NULL DEFAULT 0,
  "hasMixedRates"  BOOLEAN     NOT NULL DEFAULT false,
  "status"         TEXT        NOT NULL DEFAULT 'draft',
  "issuedAt"       TIMESTAMP(3),
  "paidAt"         TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TimeflowInvoice_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TimeflowInvoice_organizationId_userId_idx"
  ON "TimeflowInvoice" ("organizationId", "userId");

CREATE INDEX IF NOT EXISTS "TimeflowInvoice_organizationId_userId_clientId_idx"
  ON "TimeflowInvoice" ("organizationId", "userId", "clientId");

CREATE INDEX IF NOT EXISTS "TimeflowInvoice_organizationId_userId_status_idx"
  ON "TimeflowInvoice" ("organizationId", "userId", "status");
