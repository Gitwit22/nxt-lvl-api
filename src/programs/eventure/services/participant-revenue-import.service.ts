import { prisma } from "../../../core/db/prisma.js";
import {
  confirmAttendeeImportForEvent,
  previewAttendeeImportForEvent,
  type AttendeeImportConfirmResponse,
  type AttendeeImportConfirmRowDecisionInput,
  type AttendeeImportPreviewResponse,
  type AttendeeImportParserStrategy,
} from "./attendee-import.service.js";
import { EventureServiceError } from "./eventure-error.js";
import { recordEventurePaymentTransaction } from "./payment-ledger.service.js";
import { isEligibleCompanyStatus } from "./participant-eligibility.service.js";
import { normalizeCompanyName } from "./sponsor-import.service.js";
import { assignRegistrationToSlot, reconcileAttendeeSlots } from "./workspace.service.js";

export type ParticipantRevenueImportPreviewRow = AttendeeImportPreviewResponse["rows"][number] & {
  revenue: {
    company?: string;
    amount?: number;
    description?: string;
    companies?: string[];
    amounts?: number[];
    warnings?: string[];
  };
};

export type ParticipantRevenueImportPreviewResponse = Omit<AttendeeImportPreviewResponse, "importType" | "summary" | "rows"> & {
  importType: "participant_revenue_attendee";
  summary: AttendeeImportPreviewResponse["summary"] & {
    revenueRowsDetected: number;
    rowsWithCompanyAnchor: number;
    totalRevenueAmount: number;
    unmatchedRevenueRows: number;
  };
  rows: ParticipantRevenueImportPreviewRow[];
};

export type ParticipantRevenueImportConfirmResponse = AttendeeImportConfirmResponse & {
  importType: "participant_revenue_attendee";
  summary: AttendeeImportConfirmResponse["summary"] & {
    revenueRowsConfirmed: number;
    unmatchedRevenueRowsCreated: number;
    paymentsUpserted: number;
    participantsConfirmed: number;
  };
};

export type EventureUnmatchedRevenueItem = {
  id: string;
  organizationId: string;
  eventId: string;
  importBatchId: string;
  importRowId?: string | null;
  rowNumber?: number | null;
  sourceCompanyName?: string | null;
  ticketBuyer?: string | null;
  attendeeName?: string | null;
  attendeeEmail?: string | null;
  amount?: number | null;
  description?: string | null;
  status: string;
  matchedParticipantId?: string | null;
  notes?: string | null;
  resolvedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function readRawString(raw: Record<string, unknown>, aliases: string[]): string | undefined {
  for (const [key, value] of Object.entries(raw)) {
    const normalized = key.trim().toLowerCase();
    const hit = aliases.some((alias) => normalized.includes(alias));
    if (!hit) continue;
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }

  return undefined;
}

function readRawRevenueAmount(raw: Record<string, unknown>): number | undefined {
  const parsed = parseRevenueAmountValues(raw);
  if (parsed.values.length === 0) return undefined;
  return parsed.values.reduce((sum, value) => sum + value, 0);
}

function splitRevenueTokens(value?: string): string[] {
  if (!value) return [];
  return value
    .split("/")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function parseMoneyToken(token: string): number | undefined {
  const match = token.match(/-?\$?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/);
  if (!match) return undefined;
  const normalized = match[0].replace(/[$,]/g, "");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}

function readRawRevenueAmountText(raw: Record<string, unknown>): string | undefined {
  return readRawString(raw, ["revenue amount", "revenue amt", "revenue total", "total amount"]);
}

function parseRevenueAmountValues(raw: Record<string, unknown>): { values: number[]; warnings: string[] } {
  const text = readRawRevenueAmountText(raw);
  if (!text) return { values: [], warnings: [] };

  const warnings: string[] = [];
  const values = splitRevenueTokens(text)
    .map((token) => {
      const value = parseMoneyToken(token);
      if (value === undefined) {
        warnings.push(`Could not parse revenue amount token \"${token}\".`);
      }
      return value;
    })
    .filter((value): value is number => value !== undefined);

  if (values.length === 0) {
    const singleValue = parseMoneyToken(text);
    if (singleValue !== undefined) {
      values.push(singleValue);
    }
  }

  return { values, warnings };
}

type ParsedRevenueEntry = {
  companyName: string;
  amount: number;
  description?: string;
  warnings: string[];
};

function parseRevenueEntries(raw: Record<string, unknown>): { entries: ParsedRevenueEntry[]; warnings: string[]; companies: string[]; amounts: number[] } {
  const revenueCompany = readRawString(raw, ["company (revenue file)", "revenue company"]);
  const revenueDescription = readRawString(raw, ["revenue description", "description", "memo", "notes"]);
  const companyTokens = splitRevenueTokens(revenueCompany);
  const { values: amountTokens, warnings } = parseRevenueAmountValues(raw);

  if (amountTokens.length === 0) {
    return { entries: [], warnings, companies: companyTokens, amounts: amountTokens };
  }

  if (companyTokens.length === 0) {
    return {
      entries: [],
      warnings: warnings.concat("Revenue amount exists but Company (Revenue File) is blank."),
      companies: companyTokens,
      amounts: amountTokens,
    };
  }

  const entries: ParsedRevenueEntry[] = [];

  if (companyTokens.length === amountTokens.length) {
    for (let index = 0; index < amountTokens.length; index += 1) {
      entries.push({
        companyName: companyTokens[index],
        amount: amountTokens[index],
        description: revenueDescription,
        warnings: [],
      });
    }
    return { entries, warnings, companies: companyTokens, amounts: amountTokens };
  }

  if (companyTokens.length === 1) {
    for (const amount of amountTokens) {
      entries.push({
        companyName: companyTokens[0],
        amount,
        description: revenueDescription,
        warnings: [],
      });
    }
    return { entries, warnings, companies: companyTokens, amounts: amountTokens };
  }

  return {
    entries: [],
    warnings: warnings.concat(
      `Revenue company and amount counts do not align (${companyTokens.length} companies, ${amountTokens.length} amounts).`,
    ),
    companies: companyTokens,
    amounts: amountTokens,
  };
}

function readNormalizedString(normalized: Record<string, unknown>, field: string): string | undefined {
  const value = normalized[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function resolveContactCompanyId(input: {
  organizationId: string;
  companyName?: string;
  suggestedCompanyId?: string;
}): Promise<string | undefined> {
  if (input.suggestedCompanyId) return input.suggestedCompanyId;
  if (!input.companyName) return undefined;

  const normalizedName = normalizeCompanyName(input.companyName);
  const company = await prisma.eventureSponsorOrganization.findFirst({
    where: {
      organizationId: input.organizationId,
      archivedAt: null,
      OR: [
        { normalizedName },
        { name: { equals: input.companyName, mode: "insensitive" } },
      ],
    },
    select: { id: true },
  });

  return company?.id;
}

async function resolveOrCreateContactCompany(input: {
  organizationId: string;
  companyName: string;
  preferredCompanyId?: string;
}): Promise<{ id: string; name: string; created: boolean }> {
  if (input.preferredCompanyId) {
    const existingById = await prisma.eventureSponsorOrganization.findFirst({
      where: {
        id: input.preferredCompanyId,
        organizationId: input.organizationId,
        archivedAt: null,
      },
      select: { id: true, name: true },
    });

    if (existingById) {
      return { id: existingById.id, name: existingById.name, created: false };
    }
  }

  const existingId = await resolveContactCompanyId({
    organizationId: input.organizationId,
    companyName: input.companyName,
  });

  if (existingId) {
    const existing = await prisma.eventureSponsorOrganization.findUnique({
      where: { id: existingId },
      select: { id: true, name: true },
    });
    if (existing) {
      return { id: existing.id, name: existing.name, created: false };
    }
  }

  const created = await prisma.eventureSponsorOrganization.create({
    data: {
      organizationId: input.organizationId,
      name: input.companyName,
      normalizedName: normalizeCompanyName(input.companyName),
      sponsorStatus: "active",
      importSource: "participant_revenue_import",
    },
    select: { id: true, name: true },
  });

  return { id: created.id, name: created.name, created: true };
}

export async function previewParticipantRevenueImportForEvent(input: {
  organizationId: string;
  eventId: string;
  createdByUserId: string;
  csvContent?: string;
  fileBuffer?: Buffer;
  fileMimeType?: string;
  fileName?: string;
  parserStrategy?: AttendeeImportParserStrategy;
}): Promise<ParticipantRevenueImportPreviewResponse> {
  const base = await previewAttendeeImportForEvent({
    ...input,
  });

  const rows = base.rows.map((row) => {
    const parsedRevenue = parseRevenueEntries(row.raw);
    const revenueAmount = parsedRevenue.amounts.reduce((sum, value) => sum + value, 0);
    const revenueDescription = readRawString(row.raw, ["revenue description", "description", "memo", "notes"]);
    const companyAnchor = parsedRevenue.companies[0];

    return {
      ...row,
      normalized: {
        ...row.normalized,
        amount: revenueAmount || row.normalized.amount,
      },
      revenue: {
        company: companyAnchor,
        amount: parsedRevenue.amounts.length > 0 ? revenueAmount : undefined,
        description: revenueDescription,
        companies: parsedRevenue.companies,
        amounts: parsedRevenue.amounts,
        warnings: parsedRevenue.warnings,
      },
    };
  });

  const revenueRowsDetected = rows.filter((row) => row.revenue.amount !== undefined).length;
  const rowsWithCompanyAnchor = rows.filter((row) => {
    return !!(row.revenue.company ?? row.suggestedCompany?.name);
  }).length;
  const unmatchedRevenueRows = rows.filter((row) => row.revenue.amount !== undefined && !row.revenue.company && !row.suggestedCompany?.id).length;
  const totalRevenueAmount = rows.reduce((sum, row) => sum + (row.revenue.amount ?? 0), 0);

  return {
    ...base,
    importType: "participant_revenue_attendee",
    summary: {
      ...base.summary,
      revenueRowsDetected,
      rowsWithCompanyAnchor,
      totalRevenueAmount,
      unmatchedRevenueRows,
    },
    rows,
  };
}

export async function confirmParticipantRevenueImportForEvent(input: {
  organizationId: string;
  eventId: string;
  createdByUserId: string;
  importBatchId: string;
  rowDecisions?: AttendeeImportConfirmRowDecisionInput[];
}): Promise<ParticipantRevenueImportConfirmResponse> {
  const base = await confirmAttendeeImportForEvent({
    organizationId: input.organizationId,
    eventId: input.eventId,
    createdByUserId: input.createdByUserId,
    importBatchId: input.importBatchId,
    rowDecisions: input.rowDecisions,
    skipParticipantCreation: true,
  });

  const decisionByRowId = new Map((input.rowDecisions ?? []).filter((item) => item.importRowId).map((item) => [item.importRowId as string, item]));
  const decisionByRowNumber = new Map((input.rowDecisions ?? []).filter((item) => item.rowNumber !== undefined).map((item) => [item.rowNumber as number, item]));

  const importRows = await prisma.eventureImportRow.findMany({
    where: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      importBatchId: input.importBatchId,
    },
    select: {
      id: true,
      rowNumber: true,
      rawData: true,
      normalizedData: true,
      createdRegistrationId: true,
    },
    orderBy: { rowNumber: "asc" },
  });

  await prisma.eventureUnmatchedRevenue.deleteMany({
    where: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      importBatchId: input.importBatchId,
    },
  });

  let revenueRowsConfirmed = 0;
  let unmatchedRevenueRowsCreated = 0;
  let paymentsUpserted = 0;
  let participantsConfirmed = 0;
  let companiesCreated = 0;

  const groupedRevenue = new Map<string, {
    contactCompanyId: string;
    companyName: string;
    flightAssignment: string;
    attendeeNames: Set<string>;
    registrationLinks: Array<{ registrationId: string; attendeeName?: string }>;
    lineItems: Array<{
      category: string;
      amount: number;
      description?: string | null;
      sourceImportBatchId: string;
      sourceImportRowId: string;
    }>;
  }>();

  for (const row of importRows) {
    const rowDecision = decisionByRowId.get(row.id) ?? decisionByRowNumber.get(row.rowNumber);
    if (rowDecision?.decision === "ignore" || rowDecision?.decision === "skip") {
      continue;
    }

    const raw = (row.rawData ?? {}) as Record<string, unknown>;
    const normalized = (row.normalizedData ?? {}) as Record<string, unknown>;
    const suggestedCompany = (normalized.suggestedCompany ?? {}) as Record<string, unknown>;
    const edited = rowDecision?.editedNormalized;

    const parsedRevenue = parseRevenueEntries(raw);
    if (parsedRevenue.amounts.length === 0) continue;

    const explicitCompanyOverride = rowDecision?.finalCompanyId?.trim() || undefined;
    const attendeeName = edited?.attendeeName?.trim() || readNormalizedString(normalized, "attendeeName");
    const attendeeEmail = edited?.attendeeEmail?.trim() || readNormalizedString(normalized, "attendeeEmail");

    if (parsedRevenue.entries.length === 0) {
      await prisma.eventureUnmatchedRevenue.create({
        data: {
          organizationId: input.organizationId,
          eventId: input.eventId,
          importBatchId: input.importBatchId,
          importRowId: row.id,
          rowNumber: row.rowNumber,
          sourceCompanyName: undefined,
          ticketBuyer: edited?.ticketBuyer?.trim() || readNormalizedString(normalized, "ticketBuyer"),
          attendeeName,
          attendeeEmail,
          amount: parsedRevenue.amounts.reduce((sum, value) => sum + value, 0) || undefined,
          description: readRawString(raw, ["revenue description", "description", "memo", "notes"]),
          status: "unmatched",
          notes: parsedRevenue.warnings.join(" ") || "No payment record.",
        },
      });
      unmatchedRevenueRowsCreated += 1;
      continue;
    }

    const flightAssignment = readNormalizedString(normalized, "flight") === "AM" ? "AM" : "PM";

    for (const entry of parsedRevenue.entries) {
      revenueRowsConfirmed += 1;

      const companyRecord = await resolveOrCreateContactCompany({
        organizationId: input.organizationId,
        companyName: entry.companyName,
        preferredCompanyId: explicitCompanyOverride,
      });

      if (companyRecord.created) {
        companiesCreated += 1;
      }

      const existingGroup = groupedRevenue.get(companyRecord.id) ?? {
        contactCompanyId: companyRecord.id,
        companyName: entry.companyName,
        flightAssignment,
        attendeeNames: new Set<string>(),
        registrationLinks: [],
        lineItems: [],
      };

      existingGroup.companyName = entry.companyName;
      if (existingGroup.flightAssignment !== "AM" && flightAssignment === "AM") {
        existingGroup.flightAssignment = "AM";
      }
      if (attendeeName) {
        existingGroup.attendeeNames.add(attendeeName);
      }
      if (row.createdRegistrationId) {
        existingGroup.registrationLinks.push({
          registrationId: row.createdRegistrationId,
          attendeeName,
        });
      }
      existingGroup.lineItems.push({
        category: "PARTICIPANT_REVENUE",
        amount: entry.amount,
        description: entry.description ?? "Imported participant revenue",
        sourceImportBatchId: input.importBatchId,
        sourceImportRowId: row.id,
      });

      groupedRevenue.set(companyRecord.id, existingGroup);
    }

    const suggestedCompanyName = readNormalizedString(suggestedCompany, "name");
    const revenueCompanyName = parsedRevenue.companies[0];
    if (revenueCompanyName && suggestedCompanyName && normalizeCompanyName(revenueCompanyName) !== normalizeCompanyName(suggestedCompanyName)) {
      await prisma.eventureUnmatchedRevenue.create({
        data: {
          organizationId: input.organizationId,
          eventId: input.eventId,
          importBatchId: input.importBatchId,
          importRowId: row.id,
          rowNumber: row.rowNumber,
          sourceCompanyName: revenueCompanyName,
          attendeeName,
          attendeeEmail,
          amount: parsedRevenue.amounts.reduce((sum, value) => sum + value, 0),
          description: `Revenue company mismatch: suggested ${suggestedCompanyName}`,
          status: "needs_review",
          notes: `Revenue company \"${revenueCompanyName}\" overrides suggested company \"${suggestedCompanyName}\".`,
        },
      });
      unmatchedRevenueRowsCreated += 1;
    }

    continue;
  }

  // Second pass: create participants for approved rows that have a matched company
  // but no revenue entries (e.g. rows where the revenue column was blank/missing).
  // These attendees are confirmed participants but payment will be recorded separately.
  for (const row of importRows) {
    const rowDecision = decisionByRowId.get(row.id) ?? decisionByRowNumber.get(row.rowNumber);
    if (rowDecision?.decision === "ignore" || rowDecision?.decision === "skip") {
      continue;
    }

    const normalized = (row.normalizedData ?? {}) as Record<string, unknown>;
    const suggestedCompany = (normalized.suggestedCompany ?? {}) as Record<string, unknown>;
    const contactCompanyId =
      rowDecision?.finalCompanyId?.trim() ||
      (typeof suggestedCompany.id === "string" ? suggestedCompany.id : undefined);

    if (!contactCompanyId) continue;
    if (groupedRevenue.has(contactCompanyId)) continue;

    const companyName = typeof suggestedCompany.name === "string" ? suggestedCompany.name.trim() : "";
    if (!companyName) continue;

    const flightAssignment = (normalized.flight === "AM" ? "AM" : "PM") as "AM" | "PM";
    const attendeeName = typeof normalized.attendeeName === "string" ? normalized.attendeeName.trim() : undefined;

    groupedRevenue.set(contactCompanyId, {
      contactCompanyId,
      companyName,
      flightAssignment,
      attendeeNames: new Set<string>(attendeeName ? [attendeeName] : []),
      registrationLinks: row.createdRegistrationId
        ? [{ registrationId: row.createdRegistrationId, attendeeName }]
        : [],
      lineItems: [],
    });
  }

  for (const group of groupedRevenue.values()) {
    if (group.lineItems.length === 0) {
      continue;
    }

    const company = await prisma.eventureSponsorOrganization.findFirst({
      where: {
        id: group.contactCompanyId,
        organizationId: input.organizationId,
        archivedAt: null,
      },
      select: { sponsorStatus: true },
    });

    if (!isEligibleCompanyStatus(company?.sponsorStatus)) {
      continue;
    }

    await prisma.eventureEventSponsor.upsert({
      where: {
        organizationId_eventId_sponsorOrganizationId: {
          organizationId: input.organizationId,
          eventId: input.eventId,
          sponsorOrganizationId: group.contactCompanyId,
        },
      },
      update: {
      },
      create: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        sponsorOrganizationId: group.contactCompanyId,
      },
    });

    let participant = await prisma.eventureParticipant.findFirst({
      where: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        contactCompanyId: group.contactCompanyId,
      },
      select: {
        id: true,
        companyName: true,
        attendeeCount: true,
        flightAssignment: true,
      },
    });

    if (!participant) {
      participant = await prisma.eventureParticipant.create({
        data: {
          organizationId: input.organizationId,
          eventId: input.eventId,
          contactCompanyId: group.contactCompanyId,
          companyName: group.companyName,
          paymentConfirmed: true,
          attendeeCount: 0,
          flightAssignment: group.flightAssignment,
          status: "active",
        },
        select: {
          id: true,
          companyName: true,
          attendeeCount: true,
          flightAssignment: true,
        },
      });
    } else if (participant.companyName !== group.companyName || participant.flightAssignment !== group.flightAssignment) {
      participant = await prisma.eventureParticipant.update({
        where: { id: participant.id },
        data: {
          companyName: group.companyName,
          flightAssignment: group.flightAssignment,
        },
        select: {
          id: true,
          companyName: true,
          attendeeCount: true,
          flightAssignment: true,
        },
      });
    }

    const attendeeCountTarget = Math.max(participant.attendeeCount, group.registrationLinks.length, group.attendeeNames.size);
    if (attendeeCountTarget > 0) {
      await reconcileAttendeeSlots({
        organizationId: input.organizationId,
        eventId: input.eventId,
        participantId: participant.id,
        companyName: group.companyName,
        attendeeCount: attendeeCountTarget,
        flightAssignment: group.flightAssignment,
      });
    }

    if (group.lineItems.length > 0) {
      const totalAmount = group.lineItems.reduce((sum, item) => sum + item.amount, 0);
      const { payment } = await recordEventurePaymentTransaction({
        organizationId: input.organizationId,
        eventId: input.eventId,
        contactCompanyId: group.contactCompanyId,
        participantId: participant.id,
        amountDue: totalAmount,
        amountPaid: totalAmount,
        notes: group.lineItems.map((item) => item.description).filter(Boolean).join(" | ") || undefined,
        changedByUserId: input.createdByUserId,
        transactionType: "import_participant_revenue",
        source: "participant_revenue_import",
        lineItems: group.lineItems,
      });
      paymentsUpserted += 1;

      await prisma.eventureParticipant.update({
        where: { id: participant.id },
        data: {
          attendeeCount: attendeeCountTarget,
          paymentConfirmed: true,
          paymentId: payment.id,
          status: "active",
        },
      });
    }
    participantsConfirmed += 1;

    for (const registrationLink of group.registrationLinks) {
      await assignRegistrationToSlot({
        organizationId: input.organizationId,
        eventId: input.eventId,
        registrationId: registrationLink.registrationId,
        contactCompanyId: group.contactCompanyId,
        attendeeFullName: registrationLink.attendeeName,
        actorUserId: input.createdByUserId,
      });
    }
  }

  return {
    ...base,
    importType: "participant_revenue_attendee",
    summary: {
      ...base.summary,
      companiesCreated: base.summary.companiesCreated + companiesCreated,
      revenueRowsConfirmed,
      unmatchedRevenueRowsCreated,
      paymentsUpserted,
      participantsConfirmed,
    },
  };
}

export async function listUnmatchedRevenueForEvent(
  organizationId: string,
  eventId: string,
): Promise<EventureUnmatchedRevenueItem[]> {
  return prisma.eventureUnmatchedRevenue.findMany({
    where: {
      organizationId,
      eventId,
    },
    orderBy: [
      { createdAt: "desc" },
      { rowNumber: "asc" },
    ],
  });
}

export async function matchUnmatchedRevenueToParticipant(input: {
  organizationId: string;
  eventId: string;
  unmatchedRevenueId: string;
  participantId: string;
  notes?: string;
}): Promise<EventureUnmatchedRevenueItem> {
  const participant = await prisma.eventureParticipant.findFirst({
    where: {
      id: input.participantId,
      organizationId: input.organizationId,
      eventId: input.eventId,
    },
    select: { id: true },
  });

  if (!participant) {
    throw new EventureServiceError("Participant not found for this event.", 404);
  }

  const unmatched = await prisma.eventureUnmatchedRevenue.findFirst({
    where: {
      id: input.unmatchedRevenueId,
      organizationId: input.organizationId,
      eventId: input.eventId,
    },
    select: { id: true },
  });

  if (!unmatched) {
    throw new EventureServiceError("Unmatched revenue row not found.", 404);
  }

  return prisma.eventureUnmatchedRevenue.update({
    where: { id: input.unmatchedRevenueId },
    data: {
      status: "manually_matched",
      matchedParticipantId: input.participantId,
      notes: input.notes,
      resolvedAt: new Date(),
    },
  });
}

export async function ignoreUnmatchedRevenue(input: {
  organizationId: string;
  eventId: string;
  unmatchedRevenueId: string;
  notes?: string;
}): Promise<EventureUnmatchedRevenueItem> {
  const unmatched = await prisma.eventureUnmatchedRevenue.findFirst({
    where: {
      id: input.unmatchedRevenueId,
      organizationId: input.organizationId,
      eventId: input.eventId,
    },
    select: { id: true },
  });

  if (!unmatched) {
    throw new EventureServiceError("Unmatched revenue row not found.", 404);
  }

  return prisma.eventureUnmatchedRevenue.update({
    where: { id: input.unmatchedRevenueId },
    data: {
      status: "ignored",
      notes: input.notes,
      resolvedAt: new Date(),
    },
  });
}