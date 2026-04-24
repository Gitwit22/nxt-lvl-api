-- ---------------------------------------------------------------------------
-- Community Chronicle batch PDF grouping (Phase 1 + Phase 2 shadow mode)
-- Adds parent/segment metadata and stores page-level features + boundary scores.
-- ---------------------------------------------------------------------------

ALTER TABLE "Document"
  ADD COLUMN IF NOT EXISTS "parentDocumentId" TEXT,
  ADD COLUMN IF NOT EXISTS "rootDocumentId" TEXT,
  ADD COLUMN IF NOT EXISTS "isVirtualSegment" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "segmentIndex" INTEGER,
  ADD COLUMN IF NOT EXISTS "segmentPageStart" INTEGER,
  ADD COLUMN IF NOT EXISTS "segmentPageEnd" INTEGER,
  ADD COLUMN IF NOT EXISTS "segmentConfidence" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "splitReviewRequired" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "segmentationStatus" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Document_parentDocumentId_fkey'
  ) THEN
    ALTER TABLE "Document"
      ADD CONSTRAINT "Document_parentDocumentId_fkey"
      FOREIGN KEY ("parentDocumentId")
      REFERENCES "Document"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Document_org_domain_parent_idx"
  ON "Document" ("organizationId", "programDomain", "parentDocumentId");

CREATE INDEX IF NOT EXISTS "Document_org_domain_root_idx"
  ON "Document" ("organizationId", "programDomain", "rootDocumentId");

CREATE INDEX IF NOT EXISTS "Document_org_domain_split_review_idx"
  ON "Document" ("organizationId", "programDomain", "splitReviewRequired", "updatedAt");

CREATE TABLE IF NOT EXISTS "ChroniclePdfPageFeature" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "programDomain" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "pageIndex" INTEGER NOT NULL,
  "topLines" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "bottomLines" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "headerTitle" TEXT,
  "identifierTokens" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "pageNumberCue" JSONB,
  "templateSignature" TEXT,
  "layoutHints" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChroniclePdfPageFeature_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChroniclePdfPageFeature_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ChroniclePdfPageFeature_doc_page_idx"
  ON "ChroniclePdfPageFeature" ("documentId", "pageIndex");

CREATE INDEX IF NOT EXISTS "ChroniclePdfPageFeature_scope_idx"
  ON "ChroniclePdfPageFeature" ("organizationId", "programDomain", "documentId");

CREATE TABLE IF NOT EXISTS "ChroniclePdfBoundaryDecision" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "programDomain" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "leftPageIndex" INTEGER NOT NULL,
  "rightPageIndex" INTEGER NOT NULL,
  "continuationScore" DOUBLE PRECISION NOT NULL,
  "boundaryScore" DOUBLE PRECISION NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "decision" TEXT NOT NULL,
  "reasons" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "evidence" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChroniclePdfBoundaryDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChroniclePdfBoundaryDecision_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ChroniclePdfBoundaryDecision_doc_pair_idx"
  ON "ChroniclePdfBoundaryDecision" ("documentId", "leftPageIndex", "rightPageIndex");

CREATE INDEX IF NOT EXISTS "ChroniclePdfBoundaryDecision_scope_idx"
  ON "ChroniclePdfBoundaryDecision" ("organizationId", "programDomain", "documentId");
