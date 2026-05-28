import { Prisma } from "@prisma/client";
import { prisma } from "../../../core/db/prisma.js";

export type EventureSponsorOrganizationWithContacts = Awaited<ReturnType<typeof prisma.eventureSponsorOrganization.findMany>>[number];

export async function getActiveEventForOrganization(organizationId: string, eventId: string) {
  return prisma.eventureEvent.findFirst({
    where: {
      id: eventId,
      organizationId,
      archivedAt: null,
    },
  });
}

export async function listSponsorOrganizationsForOrganization(organizationId: string) {
  return prisma.eventureSponsorOrganization.findMany({
    where: { organizationId },
    include: { contacts: true },
    orderBy: { name: "asc" },
  });
}

export async function listEventSponsorsForEvent(organizationId: string, eventId: string) {
  return prisma.eventureEventSponsor.findMany({
    where: { organizationId, eventId },
    select: {
      id: true,
      sponsorOrganizationId: true,
    },
  });
}

export async function createImportBatch(input: {
  organizationId: string;
  eventId: string;
  fileName: string;
  fileType: string;
  fileUrl: string;
  createdByUserId: string;
  totalRows: number;
  mappingConfig: Record<string, unknown>;
}) {
  return prisma.eventureImportBatch.create({
    data: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      fileName: input.fileName,
      fileType: input.fileType,
      fileUrl: input.fileUrl,
      sourceType: "sponsor_master_list",
      status: "processing",
      totalRows: input.totalRows,
      mappingConfig: input.mappingConfig as Prisma.InputJsonValue,
      createdByUserId: input.createdByUserId,
    },
  });
}

export async function completeImportBatch(input: {
  importBatchId: string;
  parsedRows: number;
  validRows: number;
  errorRows: number;
  duplicateRows: number;
}) {
  return prisma.eventureImportBatch.update({
    where: { id: input.importBatchId },
    data: {
      status: "completed",
      parsedRows: input.parsedRows,
      validRows: input.validRows,
      errorRows: input.errorRows,
      duplicateRows: input.duplicateRows,
      completedAt: new Date(),
    },
  });
}

export async function failImportBatch(importBatchId: string) {
  return prisma.eventureImportBatch.update({
    where: { id: importBatchId },
    data: {
      status: "failed",
      completedAt: new Date(),
    },
  });
}

export async function createImportRow(input: {
  organizationId: string;
  eventId: string;
  importBatchId: string;
  rowNumber: number;
  rawData: Record<string, unknown>;
  normalizedData: Record<string, unknown>;
  status: string;
  errorMessage?: string;
}) {
  return prisma.eventureImportRow.create({
    data: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      importBatchId: input.importBatchId,
      rowNumber: input.rowNumber,
      rawData: input.rawData as Prisma.InputJsonValue,
      normalizedData: input.normalizedData as Prisma.InputJsonValue,
      status: input.status,
      errorMessage: input.errorMessage,
    },
  });
}

export async function createSponsorOrganization(input: {
  organizationId: string;
  name: string;
  normalizedName: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  mainEmail?: string;
  mainPhone?: string;
  website?: string;
  notes?: string;
  sourceImportBatchId?: string;
}) {
  return prisma.eventureSponsorOrganization.create({
    data: {
      organizationId: input.organizationId,
      name: input.name,
      normalizedName: input.normalizedName,
      addressLine1: input.addressLine1,
      city: input.city,
      state: input.state,
      zipCode: input.zipCode,
      mainEmail: input.mainEmail,
      mainPhone: input.mainPhone,
      website: input.website,
      notes: input.notes,
      sourceImportBatchId: input.sourceImportBatchId,
    },
    include: { contacts: true },
  });
}

export async function updateSponsorOrganization(input: {
  id: string;
  name?: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  mainEmail?: string;
  mainPhone?: string;
  website?: string;
  notes?: string;
  sourceImportBatchId?: string;
}) {
  return prisma.eventureSponsorOrganization.update({
    where: { id: input.id },
    data: {
      name: input.name,
      addressLine1: input.addressLine1,
      city: input.city,
      state: input.state,
      zipCode: input.zipCode,
      mainEmail: input.mainEmail,
      mainPhone: input.mainPhone,
      website: input.website,
      notes: input.notes,
      sourceImportBatchId: input.sourceImportBatchId,
    },
    include: { contacts: true },
  });
}

export async function upsertEventSponsor(input: {
  organizationId: string;
  eventId: string;
  sponsorOrganizationId: string;
  sponsorshipPackage?: string;
  committedAmount?: number;
  amountPaid?: number;
  paymentStatus: string;
  paymentNotes?: string;
  flightPreference?: string;
  logoStatus?: string;
  attendeeNamesRaw?: string;
  statusRaw?: string;
  notes?: string;
  pointPersonName?: string;
  pointPersonUserId?: string;
  sourceImportBatchId?: string;
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
      sponsorshipPackage: input.sponsorshipPackage,
      committedAmount: input.committedAmount,
      amountPaid: input.amountPaid,
      paymentStatus: input.paymentStatus,
      paymentNotes: input.paymentNotes,
      flightPreference: input.flightPreference,
      logoStatus: input.logoStatus,
      attendeeNamesRaw: input.attendeeNamesRaw,
      statusRaw: input.statusRaw,
      notes: input.notes,
      pointPersonName: input.pointPersonName,
      pointPersonUserId: input.pointPersonUserId,
      sourceImportBatchId: input.sourceImportBatchId,
    },
    create: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      sponsorOrganizationId: input.sponsorOrganizationId,
      sponsorshipPackage: input.sponsorshipPackage,
      committedAmount: input.committedAmount,
      amountPaid: input.amountPaid,
      paymentStatus: input.paymentStatus,
      paymentNotes: input.paymentNotes,
      flightPreference: input.flightPreference,
      logoStatus: input.logoStatus,
      attendeeNamesRaw: input.attendeeNamesRaw,
      statusRaw: input.statusRaw,
      notes: input.notes,
      pointPersonName: input.pointPersonName,
      pointPersonUserId: input.pointPersonUserId,
      sourceImportBatchId: input.sourceImportBatchId,
    },
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

export async function upsertSponsorYearHistory(input: {
  organizationId: string;
  sponsorOrganizationId: string;
  year: number;
  rawValue?: string;
  amount?: number;
  participationStatus: string;
  sourceType: string;
  sourceImportBatchId?: string;
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
      rawValue: input.rawValue,
      amount: input.amount,
      participationStatus: input.participationStatus,
      sourceImportBatchId: input.sourceImportBatchId,
    },
    create: {
      organizationId: input.organizationId,
      sponsorOrganizationId: input.sponsorOrganizationId,
      year: input.year,
      rawValue: input.rawValue,
      amount: input.amount,
      participationStatus: input.participationStatus,
      sourceType: input.sourceType,
      sourceImportBatchId: input.sourceImportBatchId,
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
    },
  });
}

export async function createSponsorContact(input: {
  organizationId: string;
  sponsorOrganizationId: string;
  name: string;
  email?: string;
  phone?: string;
  role?: string;
  isPrimary?: boolean;
  sourceImportBatchId?: string;
}) {
  return prisma.eventureSponsorContact.create({
    data: {
      organizationId: input.organizationId,
      sponsorOrganizationId: input.sponsorOrganizationId,
      name: input.name,
      email: input.email,
      phone: input.phone,
      role: input.role,
      isPrimary: input.isPrimary ?? false,
      sourceImportBatchId: input.sourceImportBatchId,
    },
  });
}

export async function updateSponsorContact(input: {
  id: string;
  name?: string;
  email?: string;
  phone?: string;
  role?: string;
  isPrimary?: boolean;
  sourceImportBatchId?: string;
}) {
  return prisma.eventureSponsorContact.update({
    where: { id: input.id },
    data: {
      name: input.name,
      email: input.email,
      phone: input.phone,
      role: input.role,
      isPrimary: input.isPrimary,
      sourceImportBatchId: input.sourceImportBatchId,
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
