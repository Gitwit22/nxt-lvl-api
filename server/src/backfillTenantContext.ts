import "dotenv/config";
import { prisma } from "./core/db/prisma.js";
import { CURRENT_PROGRAM_DOMAIN, DEFAULT_ORGANIZATION_ID } from "./core/config/env.js";
import { logger } from "./logger.js";

async function backfillTenantContext(): Promise<void> {
  const userResult = await prisma.$executeRaw`
    UPDATE "User"
    SET "organizationId" = ${DEFAULT_ORGANIZATION_ID}
    WHERE "organizationId" IS NULL OR "organizationId" = ''
  `;

  const documentResult = await prisma.$executeRaw`
    UPDATE "Document"
    SET
      "organizationId" = COALESCE(NULLIF("organizationId", ''), ${DEFAULT_ORGANIZATION_ID}),
      "programDomain" = COALESCE(NULLIF("programDomain", ''), ${CURRENT_PROGRAM_DOMAIN}),
      "createdByUserId" = COALESCE("createdByUserId", "uploadedById")
    WHERE
      "organizationId" IS NULL
      OR "organizationId" = ''
      OR "programDomain" IS NULL
      OR "programDomain" = ''
      OR ("createdByUserId" IS NULL AND "uploadedById" IS NOT NULL)
  `;

  const jobResult = await prisma.$executeRaw`
    UPDATE "ProcessingJob" AS job
    SET
      "organizationId" = doc."organizationId",
      "programDomain" = doc."programDomain"
    FROM "Document" AS doc
    WHERE job."documentId" = doc."id"
      AND (
        job."organizationId" IS NULL
        OR job."organizationId" = ''
        OR job."programDomain" IS NULL
        OR job."programDomain" = ''
      )
  `;

  logger.info("Tenant backfill completed", {
    usersUpdated: Number(userResult),
    documentsUpdated: Number(documentResult),
    jobsUpdated: Number(jobResult),
    organizationId: DEFAULT_ORGANIZATION_ID,
    programDomain: CURRENT_PROGRAM_DOMAIN,
  });
}

void backfillTenantContext()
  .catch((error) => {
    logger.error("Tenant backfill failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });