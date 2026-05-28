import { prisma } from "../../../core/db/prisma.js";

export async function listEventSponsors(organizationId: string, eventId: string) {
  return prisma.eventureEventSponsor.findMany({
    where: {
      organizationId,
      eventId,
    },
    include: {
      sponsorOrganization: {
        include: {
          contacts: {
            orderBy: [{ isPrimary: "desc" }, { updatedAt: "desc" }],
          },
        },
      },
    },
    orderBy: [{ sponsorOrganization: { name: "asc" } }],
  });
}

export async function listSponsorFollowUps(organizationId: string, eventId: string) {
  return prisma.eventureSponsorFollowUp.findMany({
    where: {
      organizationId,
      eventId,
    },
    include: {
      sponsorOrganization: true,
      eventSponsor: true,
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });
}
