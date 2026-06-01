import { prisma } from "../../../core/db/prisma.js";

export type SharedDirectoryFilters = {
  organizationId: string;
  eventId?: string;
  includeHistory?: boolean;
  status?: "active" | "archived" | "all";
};

function normalizeStatusFilter(status?: string): "active" | "archived" | "all" {
  if (status === "archived" || status === "all") return status;
  return "active";
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (value: unknown) => {
    const text = value === undefined || value === null ? "" : String(value);
    if (/[",\n\r]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };

  const headerLine = headers.join(",");
  const lines = rows.map((row) => headers.map((header) => escape(row[header])).join(","));
  return [headerLine, ...lines].join("\n");
}

export async function listSharedSponsors(input: SharedDirectoryFilters) {
  const status = normalizeStatusFilter(input.status);

  const eventSponsors = await prisma.eventureEventSponsor.findMany({
    where: {
      organizationId: input.organizationId,
      ...(input.eventId ? { eventId: input.eventId } : {}),
      ...(status === "active" ? { archivedAt: null } : {}),
      ...(status === "archived" ? { archivedAt: { not: null } } : {}),
    },
    include: {
      event: { select: { id: true, title: true, startDateTime: true } },
      sponsorOrganization: {
        include: {
          contacts: {
            where: status === "all" ? undefined : (status === "active" ? { archivedAt: null } : { archivedAt: { not: null } }),
            orderBy: { isPrimary: "desc" },
          },
          eventSponsors: {
            where: status === "all" ? undefined : (status === "active" ? { archivedAt: null } : { archivedAt: { not: null } }),
            include: { event: { select: { title: true, startDateTime: true } } },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return eventSponsors.map((row) => {
    const primaryContact = row.sponsorOrganization.contacts[0];
    const history = row.sponsorOrganization.eventSponsors;
    const sortedHistory = [...history].sort((a, b) => b.event.startDateTime.getTime() - a.event.startDateTime.getTime());
    const last = sortedHistory[0];
    const totalCommitted = history.reduce((sum, item) => sum + (item.committedAmount ?? 0), 0);
    const totalPaid = history.reduce((sum, item) => sum + (item.amountPaid ?? 0), 0);

    return {
      sponsorId: row.id,
      organizationId: row.organizationId,
      companyName: row.sponsorOrganization.name,
      representativeName: primaryContact?.name ?? null,
      email: primaryContact?.email ?? row.sponsorOrganization.mainEmail ?? null,
      phone: primaryContact?.phone ?? row.sponsorOrganization.mainPhone ?? null,
      address: [
        row.sponsorOrganization.addressLine1,
        row.sponsorOrganization.city,
        row.sponsorOrganization.state,
        row.sponsorOrganization.zipCode,
      ].filter(Boolean).join(", "),
      sponsorHistoryCount: history.length,
      lastSponsoredEvent: last?.event.title ?? null,
      currentEventSponsorStatus: row.paymentStatus,
      totalCommitted,
      totalPaid,
      tags: "",
      sourceEvent: row.event.title,
      sourceImportBatchId: row.sourceImportBatchId ?? row.sponsorOrganization.sourceImportBatchId ?? null,
      includeHistory: input.includeHistory ?? false,
    };
  });
}

export async function listSharedCompanies(input: SharedDirectoryFilters) {
  const status = normalizeStatusFilter(input.status);
  const companies = await prisma.eventureSponsorOrganization.findMany({
    where: {
      organizationId: input.organizationId,
      ...(status === "active" ? { archivedAt: null } : {}),
      ...(status === "archived" ? { archivedAt: { not: null } } : {}),
    },
    orderBy: { name: "asc" },
  });

  return companies.map((company) => ({
    id: company.id,
    organizationId: company.organizationId,
    name: company.name,
    mainEmail: company.mainEmail,
    mainPhone: company.mainPhone,
    city: company.city,
    state: company.state,
    zipCode: company.zipCode,
    sourceImportBatchId: company.sourceImportBatchId,
    archivedAt: company.archivedAt?.toISOString() ?? null,
  }));
}

export async function listSharedContacts(input: SharedDirectoryFilters) {
  const status = normalizeStatusFilter(input.status);
  const contacts = await prisma.eventureSponsorContact.findMany({
    where: {
      organizationId: input.organizationId,
      ...(status === "active" ? { archivedAt: null } : {}),
      ...(status === "archived" ? { archivedAt: { not: null } } : {}),
    },
    include: {
      sponsorOrganization: {
        select: {
          id: true,
          name: true,
        },
      },
    },
    orderBy: { name: "asc" },
  });

  return contacts.map((contact) => ({
    id: contact.id,
    organizationId: contact.organizationId,
    sponsorOrganizationId: contact.sponsorOrganizationId,
    sponsorOrganizationName: contact.sponsorOrganization.name,
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    role: contact.role,
    sourceImportBatchId: contact.sourceImportBatchId,
    archivedAt: contact.archivedAt?.toISOString() ?? null,
  }));
}

export function serializeCsv(rows: Array<Record<string, unknown>>) {
  return toCsv(rows);
}
