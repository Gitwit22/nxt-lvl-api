import "dotenv/config";
import { prisma } from "../core/db/prisma.js";
import { SUITE_PROGRAM_DOMAIN, suiteProgramCatalog } from "../core/data/suite-program-catalog.js";

async function seedSuitePrograms() {
  let createdCount = 0;
  let updatedCount = 0;

  for (const program of suiteProgramCatalog) {
    const existing = await prisma.program.findFirst({
      where: {
        programDomain: SUITE_PROGRAM_DOMAIN,
        slug: program.slug,
      },
    });

    if (existing) {
      await prisma.program.update({
        where: { id: existing.id },
        data: {
          organizationId: program.organizationId,
          slug: program.slug,
          name: program.name,
          shortDescription: program.shortDescription,
          longDescription: program.longDescription,
          category: program.category,
          tags: program.tags,
          status: program.status,
          type: program.type,
          origin: program.origin,
          internalRoute: program.internalRoute,
          externalUrl: program.externalUrl,
          openInNewTab: program.openInNewTab,
          logoUrl: program.logoUrl,
          screenshotUrl: program.screenshotUrl,
          accentColor: program.accentColor,
          isFeatured: program.isFeatured,
          isPublic: program.isPublic,
          requiresLogin: program.requiresLogin,
          requiresApproval: program.requiresApproval,
          launchLabel: program.launchLabel,
          displayOrder: program.displayOrder,
          notes: program.notes,
          deletedAt: null,
        },
      });
      updatedCount += 1;
      continue;
    }

    await prisma.program.create({
      data: {
        id: program.id,
        programDomain: SUITE_PROGRAM_DOMAIN,
        organizationId: program.organizationId,
        slug: program.slug,
        name: program.name,
        shortDescription: program.shortDescription,
        longDescription: program.longDescription,
        category: program.category,
        tags: program.tags,
        status: program.status,
        type: program.type,
        origin: program.origin,
        internalRoute: program.internalRoute,
        externalUrl: program.externalUrl,
        openInNewTab: program.openInNewTab,
        logoUrl: program.logoUrl,
        screenshotUrl: program.screenshotUrl,
        accentColor: program.accentColor,
        isFeatured: program.isFeatured,
        isPublic: program.isPublic,
        requiresLogin: program.requiresLogin,
        requiresApproval: program.requiresApproval,
        launchLabel: program.launchLabel,
        displayOrder: program.displayOrder,
        notes: program.notes,
      },
    });
    createdCount += 1;
  }

  console.log(
    JSON.stringify(
      {
        programDomain: SUITE_PROGRAM_DOMAIN,
        totalCatalogEntries: suiteProgramCatalog.length,
        createdCount,
        updatedCount,
      },
      null,
      2,
    ),
  );
}

seedSuitePrograms()
  .catch((error) => {
    console.error("Failed to seed suite programs:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });