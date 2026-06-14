import { prisma } from "../../../core/db/prisma.js";
import {
  archiveEventSponsor,
  archiveSponsorContact,
  getActiveEventForOrganization,
  getEventSponsor,
  getSponsorContactForOrganization,
  getSponsorOrganizationForOrganization,
  listEventSponsors,
  listSponsorFollowUps,
  findMatchingContact,
} from "../repositories/sponsor.repository.js";
import { EventureServiceError } from "./eventure-error.js";
import { normalizeCompanyName } from "./sponsor-import.service.js";

function normalizeValue(value?: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizeText(value?: string | null): string {
  return (value ?? "").trim();
}

function normalizeName(value?: string | null): string {
  return normalizeText(value).replace(/\s+/g, " ").toLowerCase();
}

function isMissingLogo(value?: string | null): boolean {
  const normalized = normalizeValue(value);
  if (!normalized) return true;
  return normalized.includes("need") || normalized.includes("pending") || normalized === "tbd";
}

function isMissingNames(value?: string | null): boolean {
  const normalized = normalizeValue(value);
  if (!normalized) return true;
  return normalized.includes("pending") || normalized.includes("tbd") || normalized.includes("need");
}

function ensureEvent(event: Awaited<ReturnType<typeof getActiveEventForOrganization>>) {
  if (!event) {
    throw new EventureServiceError("Event not found.", 404);
  }
}

function mergeField<T>(existingValue: T | null | undefined, incomingValue: T | null | undefined) {
  return incomingValue === undefined ? existingValue : incomingValue;
}

async function resolveSponsorOrganization(
  organizationId: string,
  input: {
    sponsorOrganizationId?: string;
    sponsorOrganization?: {
      name?: string;
      mainEmail?: string | null;
      mainPhone?: string | null;
      city?: string | null;
      state?: string | null;
      zipCode?: string | null;
      addressLine1?: string | null;
      website?: string | null;
      notes?: string | null;
    };
    sourceImportBatchId?: string | null;
  },
) {
  if (input.sponsorOrganizationId) {
    const existing = await getSponsorOrganizationForOrganization(organizationId, input.sponsorOrganizationId);
    if (!existing) {
      throw new EventureServiceError("Sponsor organization not found.", 404);
    }

    return prisma.eventureSponsorOrganization.update({
      where: { id: existing.id },
      data: {
        name: mergeField(existing.name, input.sponsorOrganization?.name),
        normalizedName: normalizeCompanyName(mergeField(existing.name, input.sponsorOrganization?.name) ?? ""),
        addressLine1: mergeField(existing.addressLine1, input.sponsorOrganization?.addressLine1),
        city: mergeField(existing.city, input.sponsorOrganization?.city),
        state: mergeField(existing.state, input.sponsorOrganization?.state),
        zipCode: mergeField(existing.zipCode, input.sponsorOrganization?.zipCode),
        mainEmail: mergeField(existing.mainEmail, input.sponsorOrganization?.mainEmail),
        mainPhone: mergeField(existing.mainPhone, input.sponsorOrganization?.mainPhone),
        website: mergeField(existing.website, input.sponsorOrganization?.website),
        notes: mergeField(existing.notes, input.sponsorOrganization?.notes),
        sourceImportBatchId: input.sourceImportBatchId ?? undefined,
        archivedAt: null,
      },
      include: {
        contacts: {
          where: { archivedAt: null },
          orderBy: [{ isPrimary: "desc" }, { updatedAt: "desc" }],
        },
      },
    });
  }

  const requestedName = normalizeText(input.sponsorOrganization?.name);
  if (!requestedName) {
    throw new EventureServiceError("sponsorOrganization.name is required.", 400);
  }

  const normalizedName = normalizeCompanyName(requestedName);
  const existing = await prisma.eventureSponsorOrganization.findFirst({
    where: { organizationId, normalizedName },
    include: {
      contacts: {
        where: { archivedAt: null },
        orderBy: [{ isPrimary: "desc" }, { updatedAt: "desc" }],
      },
    },
  });

  if (existing) {
    return prisma.eventureSponsorOrganization.update({
      where: { id: existing.id },
      data: {
        name: requestedName,
        normalizedName,
        addressLine1: input.sponsorOrganization?.addressLine1 ?? existing.addressLine1,
        city: input.sponsorOrganization?.city ?? existing.city,
        state: input.sponsorOrganization?.state ?? existing.state,
        zipCode: input.sponsorOrganization?.zipCode ?? existing.zipCode,
        mainEmail: input.sponsorOrganization?.mainEmail ?? existing.mainEmail,
        mainPhone: input.sponsorOrganization?.mainPhone ?? existing.mainPhone,
        website: input.sponsorOrganization?.website ?? existing.website,
        notes: input.sponsorOrganization?.notes ?? existing.notes,
        sourceImportBatchId: input.sourceImportBatchId ?? existing.sourceImportBatchId,
        archivedAt: null,
      },
      include: {
        contacts: {
          where: { archivedAt: null },
          orderBy: [{ isPrimary: "desc" }, { updatedAt: "desc" }],
        },
      },
    });
  }

  return prisma.eventureSponsorOrganization.create({
    data: {
      organizationId,
      name: requestedName,
      normalizedName,
      addressLine1: input.sponsorOrganization?.addressLine1 ?? undefined,
      city: input.sponsorOrganization?.city ?? undefined,
      state: input.sponsorOrganization?.state ?? undefined,
      zipCode: input.sponsorOrganization?.zipCode ?? undefined,
      mainEmail: input.sponsorOrganization?.mainEmail ?? undefined,
      mainPhone: input.sponsorOrganization?.mainPhone ?? undefined,
      website: input.sponsorOrganization?.website ?? undefined,
      notes: input.sponsorOrganization?.notes ?? undefined,
      sourceImportBatchId: input.sourceImportBatchId ?? undefined,
      archivedAt: null,
    },
    include: {
      contacts: {
        where: { archivedAt: null },
        orderBy: [{ isPrimary: "desc" }, { updatedAt: "desc" }],
      },
    },
  });
}

async function saveSponsorContact(
  organizationId: string,
  sponsorOrganizationId: string,
  input: {
    contactId?: string;
    contact?: {
      name?: string;
      email?: string | null;
      phone?: string | null;
      role?: string | null;
      isPrimary?: boolean;
    };
    sourceImportBatchId?: string | null;
  },
) {
  const name = normalizeText(input.contact?.name);
  const email = normalizeText(input.contact?.email);
  const phone = normalizeText(input.contact?.phone);
  const role = normalizeText(input.contact?.role);
  const isPrimary = input.contact?.isPrimary ?? false;

  if (!input.contactId && !name && !email && !phone) {
    return null;
  }

  let existing = null as Awaited<ReturnType<typeof findMatchingContact>> | null;
  if (input.contactId) {
    existing = await getSponsorContactForOrganization(organizationId, sponsorOrganizationId, input.contactId);
    if (!existing) {
      throw new EventureServiceError("Sponsor contact not found.", 404);
    }
  } else {
    existing = await findMatchingContact({
      organizationId,
      sponsorOrganizationId,
      email: email || undefined,
      phone: phone || undefined,
      name: name || undefined,
    });
  }

  if (isPrimary) {
    await prisma.eventureSponsorContact.updateMany({
      where: {
        organizationId,
        sponsorOrganizationId,
        archivedAt: null,
        NOT: existing ? { id: existing.id } : undefined,
      },
      data: { isPrimary: false },
    });
  }

  if (existing) {
    return prisma.eventureSponsorContact.update({
      where: { id: existing.id },
      data: {
        name: name || existing.name,
        email: email === "" ? null : mergeField(existing.email, email || undefined),
        phone: phone === "" ? null : mergeField(existing.phone, phone || undefined),
        role: role === "" ? null : mergeField(existing.role, role || undefined),
        isPrimary,
        sourceImportBatchId: input.sourceImportBatchId ?? existing.sourceImportBatchId,
        archivedAt: null,
      },
    });
  }

  return prisma.eventureSponsorContact.create({
    data: {
      organizationId,
      sponsorOrganizationId,
      name,
      email: email || undefined,
      phone: phone || undefined,
      role: role || undefined,
      isPrimary,
      sourceImportBatchId: input.sourceImportBatchId ?? undefined,
      archivedAt: null,
    },
  });
}

async function saveSponsorRecordForEvent(
  organizationId: string,
  eventId: string,
  input: {
    sponsorOrganizationId?: string;
    sponsorOrganization?: {
      name?: string;
      mainEmail?: string | null;
      mainPhone?: string | null;
      city?: string | null;
      state?: string | null;
      zipCode?: string | null;
      addressLine1?: string | null;
      website?: string | null;
      notes?: string | null;
    };
    sponsorshipPackage?: string | null;
    committedAmount?: number | null;
    amountPaid?: number | null;
    paymentStatus?: string;
    paymentNotes?: string | null;
    flightPreference?: string | null;
    logoStatus?: string | null;
    attendeeNamesRaw?: string | null;
    statusRaw?: string | null;
    notes?: string | null;
    pointPersonName?: string | null;
    pointPersonUserId?: string | null;
    sourceImportBatchId?: string | null;
    contact?: {
      name?: string;
      email?: string | null;
      phone?: string | null;
      role?: string | null;
      isPrimary?: boolean;
    };
    contactId?: string;
  },
) {
  const sponsorOrganization = await resolveSponsorOrganization(organizationId, {
    sponsorOrganizationId: input.sponsorOrganizationId,
    sponsorOrganization: input.sponsorOrganization,
    sourceImportBatchId: input.sourceImportBatchId,
  });

  const contact = await saveSponsorContact(organizationId, sponsorOrganization.id, {
    contactId: input.contactId,
    contact: input.contact,
    sourceImportBatchId: input.sourceImportBatchId,
  });

  const existingEventSponsor = await prisma.eventureEventSponsor.findFirst({
    where: {
      organizationId,
      eventId,
      sponsorOrganizationId: sponsorOrganization.id,
    },
  });

  const eventSponsor = await prisma.eventureEventSponsor.upsert({
    where: {
      organizationId_eventId_sponsorOrganizationId: {
        organizationId,
        eventId,
        sponsorOrganizationId: sponsorOrganization.id,
      },
    },
    update: {
      sponsorshipPackage: mergeField(existingEventSponsor?.sponsorshipPackage, input.sponsorshipPackage),
      committedAmount: mergeField(existingEventSponsor?.committedAmount, input.committedAmount),
      amountPaid: mergeField(existingEventSponsor?.amountPaid, input.amountPaid),
      paymentStatus: input.paymentStatus ?? existingEventSponsor?.paymentStatus ?? "unknown",
      paymentNotes: mergeField(existingEventSponsor?.paymentNotes, input.paymentNotes),
      flightPreference: mergeField(existingEventSponsor?.flightPreference, input.flightPreference),
      logoStatus: mergeField(existingEventSponsor?.logoStatus, input.logoStatus),
      attendeeNamesRaw: mergeField(existingEventSponsor?.attendeeNamesRaw, input.attendeeNamesRaw),
      statusRaw: mergeField(existingEventSponsor?.statusRaw, input.statusRaw),
      notes: mergeField(existingEventSponsor?.notes, input.notes),
      pointPersonName: mergeField(existingEventSponsor?.pointPersonName, input.pointPersonName),
      pointPersonUserId: mergeField(existingEventSponsor?.pointPersonUserId, input.pointPersonUserId),
      sourceImportBatchId: input.sourceImportBatchId ?? existingEventSponsor?.sourceImportBatchId,
      archivedAt: null,
    },
    create: {
      organizationId,
      eventId,
      sponsorOrganizationId: sponsorOrganization.id,
      sponsorshipPackage: input.sponsorshipPackage ?? undefined,
      committedAmount: input.committedAmount ?? undefined,
      amountPaid: input.amountPaid ?? undefined,
      paymentStatus: input.paymentStatus ?? "unknown",
      paymentNotes: input.paymentNotes ?? undefined,
      flightPreference: input.flightPreference ?? undefined,
      logoStatus: input.logoStatus ?? undefined,
      attendeeNamesRaw: input.attendeeNamesRaw ?? undefined,
      statusRaw: input.statusRaw ?? undefined,
      notes: input.notes ?? undefined,
      pointPersonName: input.pointPersonName ?? undefined,
      pointPersonUserId: input.pointPersonUserId ?? undefined,
      sourceImportBatchId: input.sourceImportBatchId ?? undefined,
      archivedAt: null,
    },
    include: {
      sponsorOrganization: {
        include: {
          contacts: {
            where: { archivedAt: null },
            orderBy: [{ isPrimary: "desc" }, { updatedAt: "desc" }],
          },
        },
      },
    },
  });

  return {
    eventSponsor,
    sponsorOrganization,
    contact,
  };
}

export async function listSponsorsForEvent(organizationId: string, eventId: string) {
  const event = await getActiveEventForOrganization(organizationId, eventId);
  ensureEvent(event);
  return listEventSponsors(organizationId, eventId);
}

export async function getSponsorForEvent(organizationId: string, eventId: string, sponsorId: string) {
  const event = await getActiveEventForOrganization(organizationId, eventId);
  ensureEvent(event);

  const sponsor = await getEventSponsor(organizationId, eventId, sponsorId);
  if (!sponsor) {
    throw new EventureServiceError("Sponsor not found.", 404);
  }

  return sponsor;
}

export async function createSponsorForEvent(
  organizationId: string,
  eventId: string,
  input: Parameters<typeof saveSponsorRecordForEvent>[2],
) {
  const event = await getActiveEventForOrganization(organizationId, eventId);
  ensureEvent(event);
  const result = await saveSponsorRecordForEvent(organizationId, eventId, input);
  return result.eventSponsor;
}

export async function updateSponsorForEvent(
  organizationId: string,
  eventId: string,
  sponsorId: string,
  input: Parameters<typeof saveSponsorRecordForEvent>[2],
) {
  const existing = await getSponsorForEvent(organizationId, eventId, sponsorId);
  if (!existing) {
    throw new EventureServiceError("Sponsor not found.", 404);
  }

  const result = await saveSponsorRecordForEvent(organizationId, eventId, {
    ...input,
    sponsorOrganizationId: existing.sponsorOrganizationId,
  });
  return result.eventSponsor;
}

export async function saveSponsorWithContactForEvent(
  organizationId: string,
  eventId: string,
  input: Parameters<typeof saveSponsorRecordForEvent>[2],
) {
  const event = await getActiveEventForOrganization(organizationId, eventId);
  ensureEvent(event);
  const result = await saveSponsorRecordForEvent(organizationId, eventId, input);
  return result;
}

export async function archiveSponsorForEvent(organizationId: string, eventId: string, sponsorId: string) {
  const sponsor = await getSponsorForEvent(organizationId, eventId, sponsorId);
  if (!sponsor) {
    throw new EventureServiceError("Sponsor not found.", 404);
  }

  const result = await archiveEventSponsor(organizationId, eventId, sponsorId);
  if (result.count === 0) {
    throw new EventureServiceError("Sponsor not found.", 404);
  }

  return sponsor;
}

export async function removeSponsorForEvent(organizationId: string, eventId: string, sponsorId: string) {
  return archiveSponsorForEvent(organizationId, eventId, sponsorId);
}

export async function listSponsorFollowUpsForEvent(organizationId: string, eventId: string) {
  const event = await getActiveEventForOrganization(organizationId, eventId);
  ensureEvent(event);
  return listSponsorFollowUps(organizationId, eventId);
}

export async function getSponsorDashboardForEvent(organizationId: string, eventId: string) {
  const sponsors = await listSponsorsForEvent(organizationId, eventId);

  // Fetch all payment records and deduplicate to the most-recent per company,
  // exactly matching the logic used by listPaymentsForEvent so that totals are consistent.
  const allPayments = await prisma.eventurePayment.findMany({
    where: { organizationId, eventId },
    orderBy: [{ updatedAt: "desc" }],
  });
  const paymentByCompany = new Map<string, (typeof allPayments)[number]>();
  for (const payment of allPayments) {
    if (!paymentByCompany.has(payment.contactCompanyId)) {
      paymentByCompany.set(payment.contactCompanyId, payment);
    }
  }
  const uniquePayments = Array.from(paymentByCompany.values());
  const totalCommittedAmount = uniquePayments.reduce((sum, p) => sum + (p.amountDue ?? 0), 0);
  const totalPaidAmount = uniquePayments.reduce((sum, p) => sum + (p.amountPaid ?? 0), 0);

  const unpaidOrInvoicedCount = sponsors.filter((sponsor) =>
    ["unpaid", "invoice_needed", "invoiced", "pending_event_payment"].includes(normalizeValue(sponsor.paymentStatus)),
  ).length;

  const needLogoCount = sponsors.filter((sponsor) => isMissingLogo(sponsor.logoStatus)).length;
  const needNamesCount = sponsors.filter((sponsor) => isMissingNames(sponsor.attendeeNamesRaw)).length;
  const needInvoicesCount = sponsors.filter((sponsor) =>
    ["invoice_needed", "invoiced"].includes(normalizeValue(sponsor.paymentStatus)),
  ).length;

  const amFlightCount = sponsors.filter((sponsor) => normalizeValue(sponsor.flightPreference).includes("am")).length;
  const pmFlightCount = sponsors.filter((sponsor) => normalizeValue(sponsor.flightPreference).includes("pm")).length;

  const statusBreakdown = sponsors.reduce<Record<string, number>>((acc, sponsor) => {
    const key = normalizeValue(sponsor.paymentStatus) || "unknown";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  return {
    totalSponsors: sponsors.length,
    totalCommittedAmount,
    totalPaidAmount,
    unpaidOrInvoicedCount,
    needLogoCount,
    needNamesCount,
    needInvoicesCount,
    amFlightCount,
    pmFlightCount,
    paymentStatusBreakdown: statusBreakdown,
  };
}

export async function archiveSponsorContactForEvent(
  organizationId: string,
  eventId: string,
  sponsorId: string,
  contactId: string,
) {
  const sponsor = await getSponsorForEvent(organizationId, eventId, sponsorId);
  if (!sponsor) {
    throw new EventureServiceError("Sponsor not found.", 404);
  }

  const contact = await getSponsorContactForOrganization(organizationId, sponsor.sponsorOrganizationId, contactId);
  if (!contact) {
    throw new EventureServiceError("Sponsor contact not found.", 404);
  }

  const result = await archiveSponsorContact(organizationId, sponsor.sponsorOrganizationId, contactId);
  if (result.count === 0) {
    throw new EventureServiceError("Sponsor contact not found.", 404);
  }

  return contact;
}

export async function removeSponsorContactForEvent(
  organizationId: string,
  eventId: string,
  sponsorId: string,
  contactId: string,
) {
  await archiveSponsorContactForEvent(organizationId, eventId, sponsorId, contactId);
  return { deleted: true };
}

export async function createSponsorContactForEvent(
  organizationId: string,
  eventId: string,
  sponsorId: string,
  input: {
    contactId?: string;
    contact?: {
      name?: string;
      email?: string | null;
      phone?: string | null;
      role?: string | null;
      isPrimary?: boolean;
    };
    sourceImportBatchId?: string | null;
  },
) {
  const sponsor = await getSponsorForEvent(organizationId, eventId, sponsorId);
  if (!sponsor) {
    throw new EventureServiceError("Sponsor not found.", 404);
  }

  const result = await saveSponsorContact(organizationId, sponsor.sponsorOrganizationId, input);
  if (!result) {
    throw new EventureServiceError("contact.name, email, or phone is required.", 400);
  }

  return result;
}

export async function updateSponsorContactForEvent(
  organizationId: string,
  eventId: string,
  sponsorId: string,
  contactId: string,
  input: {
    contact?: {
      name?: string;
      email?: string | null;
      phone?: string | null;
      role?: string | null;
      isPrimary?: boolean;
    };
    sourceImportBatchId?: string | null;
  },
) {
  const sponsor = await getSponsorForEvent(organizationId, eventId, sponsorId);
  if (!sponsor) {
    throw new EventureServiceError("Sponsor not found.", 404);
  }

  const existing = await getSponsorContactForOrganization(organizationId, sponsor.sponsorOrganizationId, contactId);
  if (!existing) {
    throw new EventureServiceError("Sponsor contact not found.", 404);
  }

  const result = await saveSponsorContact(organizationId, sponsor.sponsorOrganizationId, {
    contactId,
    contact: input.contact,
    sourceImportBatchId: input.sourceImportBatchId,
  });

  if (!result) {
    throw new EventureServiceError("Sponsor contact not found.", 404);
  }

  return result;
}
