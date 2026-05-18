-- CreateTable "MissionHubSession"
CREATE TABLE "MissionHubSession" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "MissionHubSession_userId_idx" on "MissionHubSession"("userId");

-- CreateIndex
CREATE INDEX "MissionHubSession_organizationId_idx" on "MissionHubSession"("organizationId");

-- CreateIndex
CREATE INDEX "MissionHubSession_expiresAt_idx" on "MissionHubSession"("expiresAt");
