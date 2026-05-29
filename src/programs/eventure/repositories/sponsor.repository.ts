import { prisma } from "../../../core/db/prisma.js";

const activeContactsInclude = {
  where: { archivedAt: null },
  orderBy: [{ isPrimary: "desc" as const }, { updatedAt: "desc" as const }],
};

const sponsorOrganizationInclude = {
  contacts: activeContactsInclude,
};

const eventSponsorInclude = {
  sponsorOrganization: {
    include: sponsorOrganizationInclude,
  },
};

export async function getActiveEventForOrganization(organizationId: string, eventId: string) {
  return prisma.eventureEvent.findFirst({
    where: {
      id: eventId,
      organizationId,
      archivedAt: null,
    },
  });
}

export async function listEventSponsors(organizationId: string, eventId: string) {
  return prisma.eventureEventSponsor.findMany({
    where: {
      organizationId,
      eventId,
      archivedAt: null,
    },
    include: eventSponsorInclude,
    orderBy: [{ sponsorOrganization: { name: "asc" } }],
  });
}

export async function getEventSponsor(organizationId: string, eventId: string, sponsorId: string) {
  return prisma.eventureEventSponsor.findFirst({
    where: {
      id: sponsorId,
      organizationId,
      eventId,
      archivedAt: null,
    },
    include: eventSponsorInclude,
  });
}

export async function getEventSponsorByComposite(input: {
  organizationId: string;
  eventId: string;
  sponsorOrganizationId: string;
}) {
  return prisma.eventureEventSponsor.findFirst({
    where: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      sponsorOrganizationId: input.sponsorOrganizationId,
    },
  });
}

export async function archiveEventSponsor(organizationId: string, eventId: string, sponsorId: string) {
  return prisma.eventureEventSponsor.updateMany({
    where: {
      id: sponsorId,
      organizationId,
      eventId,
      archivedAt: null,
    },
    data: { archivedAt: new Date() },
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

export async function listSponsorOrganizationsForOrganization(organizationId: string) {
  return prisma.eventureSponsorOrganization.findMany({
    where: { organizationId },
    include: sponsorOrganizationInclude,
    orderBy: { name: "asc" },
  });
}

export async function getSponsorOrganizationForOrganization(organizationId: string, sponsorOrganizationId: string) {
  return prisma.eventureSponsorOrganization.findFirst({
    where: { id: sponsorOrganizationId, organizationId, archivedAt: null },
    include: sponsorOrganizationInclude,
  });
}

export async function findSponsorOrganizationByNormalizedName(organizationId: string, normalizedName: string) {
  return prisma.eventureSponsorOrganization.findFirst({
    where: { organizationId, normalizedName },
    include: sponsorOrganizationInclude,
  });
}

export async function createSponsorOrganization(input: {
  organizationId: string;
  name: string;
  normalizedName: string;
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  mainEmail?: string | null;
  mainPhone?: string | null;
  website?: string | null;
  notes?: string | null;
  sourceImportBatchId?: string | null;
}) {
  return prisma.eventureSponsorOrganization.create({
    data: {
      organizationId: input.organizationId,
      name: input.name,
      normalizedName: input.normalizedName,
      addressLine1: input.addressLine1 ?? undefined,
      city: input.city ?? undefined,
      state: input.state ?? undefined,
      zipCode: input.zipCode ?? undefined,
      mainEmail: input.mainEmail ?? undefined,
      mainPhone: input.mainPhone ?? undefined,
      website: input.website ?? undefined,
      notes: input.notes ?? undefined,
      sourceImportBatchId: input.sourceImportBatchId ?? undefined,
    },
    include: sponsorOrganizationInclude,
  });
}

export async function updateSponsorOrganization(input: {
  id: string;
  name?: string | null;
  normalizedName?: string | null;
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  mainEmail?: string | null;
  mainPhone?: string | null;
  website?: string | null;
  notes?: string | null;
  sourceImportBatchId?: string | null;
}) {
  return prisma.eventureSponsorOrganization.update({
    where: { id: input.id },
    data: {
      name: input.name ?? undefined,
      normalizedName: input.normalizedName ?? undefined,
      addressLine1: input.addressLine1 ?? undefined,
      city: input.city ?? undefined,
      state: input.state ?? undefined,
      zipCode: input.zipCode ?? undefined,
      mainEmail: input.mainEmail ?? undefined,
      mainPhone: input.mainPhone ?? undefined,
      website: input.website ?? undefined,
      notes: input.notes ?? undefined,
      sourceImportBatchId: input.sourceImportBatchId ?? undefined,
    },
    include: sponsorOrganizationInclude,
  });
}

export async function archiveSponsorOrganization(organizationId: string, sponsorOrganizationId: string) {
  return prisma.eventureSponsorOrganization.updateMany({
    where: {
      id: sponsorOrganizationId,
      organizationId,
      archivedAt: null,
    },
    data: { archivedAt: new Date() },
  });
}

export async function getSponsorContactForOrganization(
  organizationId: string,
  sponsorOrganizationId: string,
  contactId: string,
) {
  return prisma.eventureSponsorContact.findFirst({
    where: {
      id: contactId,
      organizationId,
      sponsorOrganizationId,
      archivedAt: null,
    },
  });
}

export async function createSponsorContact(input: {
  organizationId: string;
  sponsorOrganizationId: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  role?: string | null;
  isPrimary?: boolean;
  sourceImportBatchId?: string | null;
}) {
  return prisma.eventureSponsorContact.create({
    data: {
      organizationId: input.organizationId,
      sponsorOrganizationId: input.sponsorOrganizationId,
      name: input.name,
      email: input.email ?? undefined,
      phone: input.phone ?? undefined,
      role: input.role ?? undefined,
      isPrimary: input.isPrimary ?? false,
      sourceImportBatchId: input.sourceImportBatchId ?? undefined,
    },
  });
}

export async function updateSponsorContact(input: {
  id: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  role?: string | null;
  isPrimary?: boolean;
  sourceImportBatchId?: string | null;
}) {
  return prisma.eventureSponsorContact.update({
    where: { id: input.id },
    data: {
      name: input.name ?? undefined,
      email: input.email ?? undefined,
      phone: input.phone ?? undefined,
      role: input.role ?? undefined,
      isPrimary: input.isPrimary,
      sourceImportBatchId: input.sourceImportBatchId ?? undefined,
    },
  });
}

export async function archiveSponsorContact(
  organizationId: string,
  sponsorOrganizationId: string,
  contactId: string,
) {
  return prisma.eventureSponsorContact.updateMany({
    where: {
      id: contactId,
      organizationId,
      sponsorOrganizationId,
      archivedAt: null,
    },
    data: { archivedAt: new Date() },
  });
}

export async function upsertEventSponsor(input: {
  organizationId: string;
  eventId: string;
  sponsorOrganizationId: string;
  sponsorshipPackage?: string | null;
  committedAmount?: number | null;
  amountPaid?: number | null;
  paymentStatus: string;
  paymentNotes?: string | null;
  flightPreference?: string | null;
  logoStatus?: string | null;
  attendeeNamesRaw?: string | null;
  statusRaw?: string | null;
  notes?: string | null;
  pointPersonName?: string | null;
  pointPersonUserId?: string | null;
  sourceImportBatchId?: string | null;
}) {
  return prisma.eventureEventSponsor.upsert({
    where: {
      organizationId_eventId_sponsorOrganizationId: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        sponsorOrganizationId: input.sponsorOrganizationId,
      },
    },
    update: {
      sponsorshipPackage: input.sponsorshipPackage ?? undefined,
      committedAmount: input.committedAmount ?? undefined,
      amountPaid: input.amountPaid ?? undefined,
      paymentStatus: input.paymentStatus,
      paymentNotes: input.paymentNotes ?? undefined,
      flightPreference: input.flightPreference ?? undefined,
      logoStatus: input.logoStatus ?? undefined,
      attendeeNamesRaw: input.attendeeNamesRaw ?? undefined,
      statusRaw: input.statusRaw ?? undefined,
      notes: input.notes ?? undefined,
      pointPersonName: input.pointPersonName ?? undefined,
      pointPersonUserId: input.pointPersonUserId ?? undefined,
      sourceImportBatchId: input.sourceImportBatchId ?? undefined,
    },
    create: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      sponsorOrganizationId: input.sponsorOrganizationId,
      sponsorshipPackage: input.sponsorshipPackage ?? undefined,
      committedAmount: input.committedAmount ?? undefined,
      amountPaid: input.amountPaid ?? undefined,
      paymentStatus: input.paymentStatus,
      paymentNotes: input.paymentNotes ?? undefined,
      flightPreference: input.flightPreference ?? undefined,
      logoStatus: input.logoStatus ?? undefined,
      attendeeNamesRaw: input.attendeeNamesRaw ?? undefined,
      statusRaw: input.statusRaw ?? undefined,
      notes: input.notes ?? undefined,
      pointPersonName: input.pointPersonName ?? undefined,
      pointPersonUserId: input.pointPersonUserId ?? undefined,
      sourceImportBatchId: input.sourceImportBatchId ?? undefined,
    },
  });
}

export async function upsertSponsorYearHistory(input: {
  organizationId: string;
  sponsorOrganizationId: string;
  year: number;
  rawValue?: string | null;
  amount?: number | null;
  participationStatus: string;
  sourceType: string;
  sourceImportBatchId?: string | null;
}) {
  return prisma.eventureSponsorYearHistory.upsert({
    where: {
      organizationId_sponsorOrganizationId_year_sourceType: {
        organizationId: input.organizationId,
        sponsorOrganizationId: input.sponsorOrganizationId,
        year: input.year,
        sourceType: input.sourceType,
      },
    },
    update: {
      rawValue: input.rawValue ?? undefined,
      amount: input.amount ?? undefined,
      participationStatus: input.participationStatus,
      sourceImportBatchId: input.sourceImportBatchId ?? undefined,
    },
    create: {
      organizationId: input.organizationId,
      sponsorOrganizationId: input.sponsorOrganizationId,
      year: input.year,
      rawValue: input.rawValue ?? undefined,
      amount: input.amount ?? undefined,
      participationStatus: input.participationStatus,
      sourceType: input.sourceType,
      sourceImportBatchId: input.sourceImportBatchId ?? undefined,
    },
  });
}

export async function findMatchingContact(input: {
  organizationId: string;
  sponsorOrganizationId: string;
  email?: string;
  phone?: string;
  name?: string;
}) {
  if (input.email) {
    const byEmail = await prisma.eventureSponsorContact.findFirst({
      where: {
        organizationId: input.organizationId,
        sponsorOrganizationId: input.sponsorOrganizationId,
        email: {
          equals: input.email,
          mode: "insensitive",
        },
        archivedAt: null,
      },
    });
    if (byEmail) return byEmail;
  }

  if (input.phone) {
    const byPhone = await prisma.eventureSponsorContact.findFirst({
      where: {
        organizationId: input.organizationId,
        sponsorOrganizationId: input.sponsorOrganizationId,
        phone: input.phone,
        archivedAt: null,
      },
    });
    if (byPhone) return byPhone;
  }

  return prisma.eventureSponsorContact.findFirst({
    where: {
      organizationId: input.organizationId,
      sponsorOrganizationId: input.sponsorOrganizationId,
      name: {
        equals: input.name,
        mode: "insensitive",
      },
      archivedAt: null,
    },
  });
}

export async function findExistingOpenFollowUp(input: {
  organizationId: string;
  eventId: string;
  eventSponsorId?: string;
  sponsorOrganizationId: string;
  type: string;
}) {
  return prisma.eventureSponsorFollowUp.findFirst({
    where: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      eventSponsorId: input.eventSponsorId,
      sponsorOrganizationId: input.sponsorOrganizationId,
      type: input.type,
      status: {
        in: ["open", "in_progress"],
      },
    },
  });
}

export async function createSponsorFollowUp(input: {
  organizationId: string;
  eventId: string;
  eventSponsorId?: string;
  sponsorOrganizationId: string;
  type: string;
  title: string;
  description?: string;
  assignedToName?: string;
  status?: string;
  source?: string;
  sourceImportBatchId?: string;
}) {
  return prisma.eventureSponsorFollowUp.create({
    data: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      eventSponsorId: input.eventSponsorId,
      sponsorOrganizationId: input.sponsorOrganizationId,
      type: input.type,
      title: input.title,
      description: input.description,
      assignedToName: input.assignedToName,
      status: input.status ?? "open",
      source: input.source ?? "csv_import",
      sourceImportBatchId: input.sourceImportBatchId,
    },
  });
}
