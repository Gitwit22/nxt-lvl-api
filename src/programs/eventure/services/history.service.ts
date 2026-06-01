import { prisma } from "../../../core/db/prisma.js";
import { EventureServiceError } from "./eventure-error.js";

type EventHistoryRow = {
  id: string;
  year: number | null;
  sourceEvent: string | null;
  company: string | null;
  contact: string | null;
  type: string;
  packageOrRole: string | null;
  amountCommitted: string | null;
  amountPaid: string | null;
  paymentStatus: string | null;
  source: string | null;
  notes: string | null;
  sourceRowNumber: number | null;
};

export async function listEventHistoryForEvent(organizationId: string, eventId: string) {
  const event = await prisma.eventureEvent.findFirst({
    where: {
      id: eventId,
      organizationId,
      archivedAt: null,
    },
    select: { id: true },
  });

  if (!event) {
    throw new EventureServiceError("Event not found.", 404);
  }

  const sponsorRows = await prisma.eventureEventSponsor.findMany({
    where: { organizationId, eventId, archivedAt: null },
    select: { sponsorOrganizationId: true },
  });
  const sponsorOrganizationIds = [...new Set(sponsorRows.map((row) => row.sponsorOrganizationId))];

  const sponsorContacts = sponsorOrganizationIds.length === 0
    ? []
    : await prisma.eventureSponsorContact.findMany({
      where: {
        organizationId,
        sponsorOrganizationId: { in: sponsorOrganizationIds },
        archivedAt: null,
      },
      select: { id: true },
    });

  const sponsorContactIds = sponsorContacts.map((row) => row.id);

  const [archiveRows, relatedRows] = await Promise.all([
    prisma.eventParticipationHistory.findMany({
      where: { organizationId },
      include: {
        sponsorOrganization: { select: { name: true } },
        sponsorContact: { select: { name: true } },
      },
      orderBy: [
        { sourceEventYear: "desc" },
        { createdAt: "desc" },
      ],
      take: 1000,
    }),
    prisma.eventParticipationHistory.findMany({
      where: {
        organizationId,
        OR: [
          { eventId },
          ...(sponsorOrganizationIds.length > 0 ? [{ sponsorOrganizationId: { in: sponsorOrganizationIds } }] : []),
          ...(sponsorContactIds.length > 0 ? [{ sponsorContactId: { in: sponsorContactIds } }] : []),
        ],
      },
      include: {
        sponsorOrganization: { select: { name: true } },
        sponsorContact: { select: { name: true } },
      },
      orderBy: [
        { sourceEventYear: "desc" },
        { createdAt: "desc" },
      ],
      take: 500,
    }),
  ]);

  const mapRow = (row: (typeof archiveRows)[number]): EventHistoryRow => ({
    id: row.id,
    year: row.sourceEventYear ?? null,
    sourceEvent: row.sourceEventName ?? null,
    company: row.sponsorOrganization?.name ?? row.rawCompanyName ?? null,
    contact: row.sponsorContact?.name ?? row.rawContactName ?? null,
    type: row.participationType,
    packageOrRole: row.sponsorshipPackage ?? row.rawPackage ?? row.rawRole ?? null,
    amountCommitted: row.amountCommitted?.toString() ?? null,
    amountPaid: row.amountPaid?.toString() ?? null,
    paymentStatus: row.paymentStatus ?? row.rawPaymentStatus ?? null,
    source: row.sourceSheetName ?? row.sourceImportBatchId ?? null,
    notes: row.notes ?? null,
    sourceRowNumber: row.sourceRowNumber ?? null,
  });

  return {
    related: relatedRows.map(mapRow),
    archive: archiveRows.map(mapRow),
  };
}
