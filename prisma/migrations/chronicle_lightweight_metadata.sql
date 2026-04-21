-- ─────────────────────────────────────────────────────────────────────────────
-- Community Chronicle: lightweight search-first metadata (Phase 2 refactor)
-- ─────────────────────────────────────────────────────────────────────────────

-- Add lightweight metadata columns to Document
ALTER TABLE "Document"
  ADD COLUMN IF NOT EXISTS "documentType"            TEXT,
  ADD COLUMN IF NOT EXISTS "sourceName"              TEXT,
  ADD COLUMN IF NOT EXISTS "documentDate"            TEXT,
  ADD COLUMN IF NOT EXISTS "metaPeople"              JSONB,
  ADD COLUMN IF NOT EXISTS "metaCompanies"           JSONB,
  ADD COLUMN IF NOT EXISTS "metaLocations"           JSONB,
  ADD COLUMN IF NOT EXISTS "metaReferenceNumbers"    JSONB,
  ADD COLUMN IF NOT EXISTS "metaOther"               JSONB,
  ADD COLUMN IF NOT EXISTS "classificationStatus"    TEXT,
  ADD COLUMN IF NOT EXISTS "classificationMatchedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "classificationConfidence" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "reviewRequired"          BOOLEAN NOT NULL DEFAULT FALSE;

-- Indexes for new search/filter fields
CREATE INDEX IF NOT EXISTS "Document_orgDomain_docType_idx"
  ON "Document" ("organizationId", "programDomain", "documentType");

CREATE INDEX IF NOT EXISTS "Document_orgDomain_classStatus_idx"
  ON "Document" ("organizationId", "programDomain", "classificationStatus");

CREATE INDEX IF NOT EXISTS "Document_orgDomain_reviewRequired_idx"
  ON "Document" ("organizationId", "programDomain", "reviewRequired", "updatedAt");

-- ─────────────────────────────────────────────────────────────────────────────
-- ChronicleDocumentType: type registry (system + admin-created)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ChronicleDocumentType" (
  "id"             TEXT        NOT NULL,
  "organizationId" TEXT        NOT NULL,
  "programDomain"  TEXT        NOT NULL DEFAULT 'community-chronicle',
  "key"            TEXT        NOT NULL,
  "label"          TEXT        NOT NULL,
  "description"    TEXT        NOT NULL DEFAULT '',
  "isSystemType"   BOOLEAN     NOT NULL DEFAULT FALSE,
  "isUserCreated"  BOOLEAN     NOT NULL DEFAULT FALSE,
  "active"         BOOLEAN     NOT NULL DEFAULT TRUE,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChronicleDocumentType_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ChronicleDocumentType_org_domain_key_idx"
  ON "ChronicleDocumentType" ("organizationId", "programDomain", "key");

CREATE INDEX IF NOT EXISTS "ChronicleDocumentType_org_domain_active_idx"
  ON "ChronicleDocumentType" ("organizationId", "programDomain", "active");

-- ─────────────────────────────────────────────────────────────────────────────
-- ChronicleTypeFingerprint: learned classification patterns
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ChronicleTypeFingerprint" (
  "id"               TEXT        NOT NULL,
  "documentTypeId"   TEXT        NOT NULL,
  "phrases"          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  "companies"        JSONB       NOT NULL DEFAULT '[]'::jsonb,
  "filenamePatterns" JSONB       NOT NULL DEFAULT '[]'::jsonb,
  "datePatterns"     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  "sampleDocumentIds" JSONB      NOT NULL DEFAULT '[]'::jsonb,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChronicleTypeFingerprint_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChronicleTypeFingerprint_documentTypeId_fkey"
    FOREIGN KEY ("documentTypeId") REFERENCES "ChronicleDocumentType" ("id") ON DELETE CASCADE,
  CONSTRAINT "ChronicleTypeFingerprint_documentTypeId_key" UNIQUE ("documentTypeId")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed system document types for community-chronicle
-- Uses a placeholder org; real org rows are seeded on first use via upsert in app
-- ─────────────────────────────────────────────────────────────────────────────
-- (Types are seeded at runtime by the API — no hard-coded org IDs here)
