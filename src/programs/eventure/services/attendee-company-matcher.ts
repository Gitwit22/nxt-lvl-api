import { normalizeCompanyName } from "./sponsor-import.service.js";
import { prisma } from "../../../core/db/prisma.js";
import { normalizeEmail } from "./attendee-import-parser.js";

export type AttendeeCompanyMatchStatus = "Matched" | "Possible Match" | "Unmatched" | "New Company Suggested";

export type AttendeeCompanyMatchResult = {
  suggestedCompanyId?: string;
  suggestedCompanyName?: string;
  matchStatus: AttendeeCompanyMatchStatus;
  confidence: number;
  reason: string;
};

type CompanyCandidate = {
  id: string;
  name: string;
  normalizedName: string;
  domain?: string;
};

function domainFromEmail(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeEmail(value);
  if (!normalized) return undefined;
  const at = normalized.indexOf("@");
  if (at < 0) return undefined;
  return normalized.slice(at + 1);
}

function extractDomainFromWebsite(value?: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  const withoutProtocol = trimmed.replace(/^https?:\/\//, "");
  return withoutProtocol.split("/")[0] || undefined;
}

function findByDomain(candidates: CompanyCandidate[], domain?: string): CompanyCandidate | undefined {
  if (!domain) return undefined;
  return candidates.find((candidate) => candidate.domain === domain || domain.endsWith(`.${candidate.domain}`));
}

function findByContainedName(candidates: CompanyCandidate[], text?: string): CompanyCandidate | undefined {
  if (!text) return undefined;
  const normalized = normalizeCompanyName(text);
  if (!normalized) return undefined;
  return candidates.find((candidate) => normalized.includes(candidate.normalizedName));
}

function findByExactName(candidates: CompanyCandidate[], text?: string): CompanyCandidate | undefined {
  if (!text) return undefined;
  const normalized = normalizeCompanyName(text);
  if (!normalized) return undefined;
  return candidates.find((candidate) => candidate.normalizedName === normalized);
}

export async function buildCompanyCandidates(organizationId: string): Promise<CompanyCandidate[]> {
  const companies = await prisma.eventureSponsorOrganization.findMany({
    where: {
      organizationId,
      archivedAt: null,
    },
    select: {
      id: true,
      name: true,
      normalizedName: true,
      mainEmail: true,
      website: true,
    },
  });

  return companies.map((company) => ({
    id: company.id,
    name: company.name,
    normalizedName: company.normalizedName,
    domain: domainFromEmail(company.mainEmail ?? undefined) ?? extractDomainFromWebsite(company.website),
  }));
}

export function matchAttendeeCompany(input: {
  candidates: CompanyCandidate[];
  ticketBuyer?: string;
  ticketBuyerEmail?: string;
  attendeeEmail?: string;
  ticketType?: string;
  eventName?: string;
}): AttendeeCompanyMatchResult {
  const byExactBuyer = findByExactName(input.candidates, input.ticketBuyer);
  if (byExactBuyer) {
    return {
      suggestedCompanyId: byExactBuyer.id,
      suggestedCompanyName: byExactBuyer.name,
      matchStatus: "Matched",
      confidence: 0.99,
      reason: "Ticket buyer matched company name.",
    };
  }

  const buyerDomain = domainFromEmail(input.ticketBuyerEmail);
  const byBuyerDomain = findByDomain(input.candidates, buyerDomain);
  if (byBuyerDomain) {
    return {
      suggestedCompanyId: byBuyerDomain.id,
      suggestedCompanyName: byBuyerDomain.name,
      matchStatus: "Matched",
      confidence: 0.96,
      reason: "Ticket buyer email domain matched company domain.",
    };
  }

  const byBuyerNameContains = findByContainedName(input.candidates, input.ticketBuyer);
  if (byBuyerNameContains) {
    return {
      suggestedCompanyId: byBuyerNameContains.id,
      suggestedCompanyName: byBuyerNameContains.name,
      matchStatus: "Possible Match",
      confidence: 0.82,
      reason: "Ticket buyer text contains known company name.",
    };
  }

  const attendeeDomain = domainFromEmail(input.attendeeEmail);
  const byAttendeeDomain = findByDomain(input.candidates, attendeeDomain);
  if (byAttendeeDomain) {
    return {
      suggestedCompanyId: byAttendeeDomain.id,
      suggestedCompanyName: byAttendeeDomain.name,
      matchStatus: "Possible Match",
      confidence: 0.8,
      reason: "Attendee email domain matched company domain.",
    };
  }

  const ticketType = (input.ticketType ?? "").toLowerCase();
  const eventName = (input.eventName ?? "").toLowerCase();
  const hasDteHint = ticketType.includes("dte") || eventName.includes("dte");
  if (hasDteHint) {
    const dteCandidate = input.candidates.find((item) => item.normalizedName.includes("dte"));
    if (dteCandidate) {
      return {
        suggestedCompanyId: dteCandidate.id,
        suggestedCompanyName: dteCandidate.name,
        matchStatus: "Possible Match",
        confidence: 0.74,
        reason: "Ticket or event label references DTE.",
      };
    }
  }

  if (input.ticketBuyer) {
    return {
      suggestedCompanyName: input.ticketBuyer,
      matchStatus: "New Company Suggested",
      confidence: 0.5,
      reason: "No existing company matched. Ticket buyer can be created as new company.",
    };
  }

  return {
    matchStatus: "Unmatched",
    confidence: 0,
    reason: "No company match found.",
  };
}
