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
import { normalizeCompanyName } from "./sponsor-import.service.js";
import { reconcileAttendeeSlots } from "./workspace.service.js";

export type ParticipantRevenueImportPreviewRow = AttendeeImportPreviewResponse["rows"][number] & {
  revenue: {
    company?: string;
    amount?: number;
    description?: string;
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
  const text = readRawString(raw, ["revenue amount", "revenue amt", "revenue total", "amount"]);
  if (!text) return undefined;
  const normalized = text.replace(/[^\d.-]/g, "");
  if (!normalized) return undefined;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
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
    const revenueCompany = readRawString(row.raw, ["company (revenue file)", "revenue company", "company"]);
    const revenueDescription = readRawString(row.raw, ["revenue description", "description", "memo", "notes"]);
    const revenueAmount = readRawRevenueAmount(row.raw);
    // For revenue-only rows (have amount but no attendee email), treat the attendeeName as the company name
    const isRevenueOnlyRow = revenueAmount !== undefined && !row.normalized.attendeeEmail;
    const companyAnchor = revenueCompany ?? (row.normalized.ticketBuyer as string | undefined) ?? (isRevenueOnlyRow ? (row.normalized.attendeeName as string | undefined) : undefined);

    return {
      ...row,
      revenue: {
        company: companyAnchor,
        amount: revenueAmount,
        description: revenueDescription,
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
  });

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

  for (const row of importRows) {
    const raw = (row.rawData ?? {}) as Record<string, unknown>;
    const normalized = (row.normalizedData ?? {}) as Record<string, unknown>;
    const suggestedCompany = (normalized.suggestedCompany ?? {}) as Record<string, unknown>;

    const revenueCompany = readRawString(raw, ["company (revenue file)", "revenue company", "company"]);
    const revenueDescription = readRawString(raw, ["revenue description", "description", "memo", "notes"]);
    const revenueAmount = readRawRevenueAmount(raw);

    if (revenueAmount === undefined) continue;

    revenueRowsConfirmed += 1;

    const suggestedCompanyId = typeof suggestedCompany.id === "string" ? suggestedCompany.id.trim() : "";
    const ticketBuyer = readNormalizedString(normalized, "ticketBuyer");
    const attendeeName = readNormalizedString(normalized, "attendeeName");
    const attendeeEmail = readNormalizedString(normalized, "attendeeEmail");
    // For revenue-only rows (have amount but no attendee email), treat attendeeName as company name
    const isRevenueOnlyRow = !attendeeEmail;
    const companyAnchor = revenueCompany ?? ticketBuyer ?? (isRevenueOnlyRow ? attendeeName : undefined);

    const hasCompanyAnchor = Boolean((companyAnchor && companyAnchor.trim()) || suggestedCompanyId);
    if (hasCompanyAnchor) {
      const contactCompanyId = await resolveContactCompanyId({
        organizationId: input.organizationId,
        companyName: companyAnchor ?? readNormalizedString(suggestedCompany, "name"),
        suggestedCompanyId,
      });

      if (contactCompanyId) {
        const existingPayment = await prisma.eventurePayment.findFirst({
          where: {
            organizationId: input.organizationId,
            eventId: input.eventId,
            contactCompanyId,
          },
          orderBy: [{ updatedAt: "desc" }],
        });

        const amountDue = revenueAmount;
        const amountPaid = revenueAmount;
        const balance = amountDue - amountPaid;

        const payment = existingPayment
          ? await prisma.eventurePayment.update({
            where: { id: existingPayment.id },
            data: {
              amountDue,
              amountPaid,
              balance,
              paymentStatus: "confirmed",
              paymentConfirmedAt: new Date(),
              notes: revenueDescription ?? existingPayment.notes,
            },
          })
          : await prisma.eventurePayment.create({
            data: {
              organizationId: input.organizationId,
              eventId: input.eventId,
              contactCompanyId,
              amountDue,
              amountPaid,
              balance,
              paymentStatus: "confirmed",
              paymentConfirmedAt: new Date(),
              notes: revenueDescription ?? null,
            },
          });

        await prisma.eventurePaymentHistory.create({
          data: {
            organizationId: input.organizationId,
            paymentId: payment.id,
            paymentStatus: payment.paymentStatus,
            amountDue: payment.amountDue,
            amountPaid: payment.amountPaid,
            balance: payment.balance,
            paymentMethod: payment.paymentMethod,
            paymentConfirmedAt: payment.paymentConfirmedAt,
            notes: payment.notes,
            changedByUserId: input.createdByUserId,
          },
        });

        paymentsUpserted += 1;

        // Link the matching Participant to this payment and confirm it
        const participant = await prisma.eventureParticipant.findFirst({
          where: {
            organizationId: input.organizationId,
            eventId: input.eventId,
            contactCompanyId,
          },
          select: {
            id: true,
            companyName: true,
            attendeeCount: true,
            flightAssignment: true,
          },
        });

        if (participant) {
          await prisma.eventureParticipant.update({
            where: { id: participant.id },
            data: {
              paymentConfirmed: true,
              paymentId: payment.id,
            },
          });
          participantsConfirmed += 1;

          if (participant.attendeeCount > 0) {
            await reconcileAttendeeSlots({
              organizationId: input.organizationId,
              eventId: input.eventId,
              participantId: participant.id,
              companyName: participant.companyName,
              attendeeCount: participant.attendeeCount,
              flightAssignment: participant.flightAssignment ?? "PM",
            });
          }
        }
      }

      continue;
    }

    await prisma.eventureUnmatchedRevenue.create({
      data: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        importBatchId: input.importBatchId,
        importRowId: row.id,
        rowNumber: row.rowNumber,
        sourceCompanyName: companyAnchor,
        ticketBuyer,
        attendeeName,
        attendeeEmail,
        amount: revenueAmount,
        description: revenueDescription,
        status: "unmatched",
      },
    });
    unmatchedRevenueRowsCreated += 1;
  }

  return {
    ...base,
    importType: "participant_revenue_attendee",
    summary: {
      ...base.summary,
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