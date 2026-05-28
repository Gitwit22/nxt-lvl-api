import { getActiveEventForOrganization } from "../repositories/sponsor-import.repository.js";
import { listEventSponsors, listSponsorFollowUps } from "../repositories/sponsor.repository.js";
import { EventureServiceError } from "./eventure-error.js";

function normalizeValue(value?: string | null): string {
  return (value ?? "").trim().toLowerCase();
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

export async function listSponsorsForEvent(organizationId: string, eventId: string) {
  const event = await getActiveEventForOrganization(organizationId, eventId);
  if (!event) throw new EventureServiceError("Event not found.", 404);
  return listEventSponsors(organizationId, eventId);
}

export async function listSponsorFollowUpsForEvent(organizationId: string, eventId: string) {
  const event = await getActiveEventForOrganization(organizationId, eventId);
  if (!event) throw new EventureServiceError("Event not found.", 404);
  return listSponsorFollowUps(organizationId, eventId);
}

export async function getSponsorDashboardForEvent(organizationId: string, eventId: string) {
  const sponsors = await listSponsorsForEvent(organizationId, eventId);

  const totalCommittedAmount = sponsors.reduce((sum, sponsor) => sum + (sponsor.committedAmount ?? 0), 0);
  const totalPaidAmount = sponsors.reduce((sum, sponsor) => sum + (sponsor.amountPaid ?? 0), 0);

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
