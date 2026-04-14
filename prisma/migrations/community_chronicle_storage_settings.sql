CREATE TABLE IF NOT EXISTS "ProgramStorageSettings" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "programDomain" TEXT NOT NULL DEFAULT 'community-chronicle',
  "settings" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProgramStorageSettings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProgramStorageSettings_organizationId_fkey" FOREIGN KEY ("organizationId")
    REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProgramStorageSettings_organizationId_programDomain_key"
  ON "ProgramStorageSettings" ("organizationId", "programDomain");

CREATE INDEX IF NOT EXISTS "ProgramStorageSettings_organizationId_programDomain_idx"
  ON "ProgramStorageSettings" ("organizationId", "programDomain");
