import "dotenv/config";
import { prisma } from "../core/db/prisma.js";

async function backfillEventureParticipantCompanyStatus() {
  const participantCompanies = await prisma.eventureParticipant.findMany({
    select: { contactCompanyId: true },
    distinct: ["contactCompanyId"],
  });

  const companyIds = participantCompanies
    .map((row) => row.contactCompanyId)
    .filter((id): id is string => !!id);

  if (companyIds.length === 0) {
    console.log("No participant-linked companies found. Nothing to update.");
    return;
  }

  const result = await prisma.eventureSponsorOrganization.updateMany({
    where: {
      id: { in: companyIds },
      archivedAt: null,
      OR: [{ sponsorStatus: null }, { sponsorStatus: { not: "active" } }],
    },
    data: {
      sponsorStatus: "active",
    },
  });

  console.log(
    JSON.stringify(
      {
        participantLinkedCompanies: companyIds.length,
        companiesUpdatedToActive: result.count,
      },
      null,
      2,
    ),
  );
}

backfillEventureParticipantCompanyStatus()
  .catch((error) => {
    console.error("Failed to backfill Eventure participant company status:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
