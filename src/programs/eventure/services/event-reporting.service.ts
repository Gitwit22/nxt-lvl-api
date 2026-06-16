import { prisma } from "../../../core/db/prisma.js";

export type ReportFlightFilter = "AM" | "PM" | "UNASSIGNED";

export type EventReportFilters = {
  paymentStatus?: string[];
  packageIds?: string[];
  companyIds?: string[];
  flight?: ReportFlightFilter;
  participantStatus?: string[];
  dateFrom?: string;
  dateTo?: string;
  source?: string[];
  includeArchived?: boolean;
};

export type EventReportException = {
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  recordType: string;
  recordId: string;
  recordName: string;
  reason: string;
  suggestedAction: string;
  openRecordAction: { type: string; id: string };
  resolveAction: { type: string; id: string };
};

export type EventReportEnvelope<TTotals extends Record<string, unknown>, TRecord = Record<string, unknown>> = {
  generatedAt: string;
  eventId: string;
  filters: EventReportFilters;
  totals: TTotals;
  records: TRecord[];
  exceptions: EventReportException[];
  dataFreshness: {
    latestPaymentAt?: string;
    latestImportAt?: string;
    latestParticipantUpdateAt?: string;
  };
};

type ReportContext = {
  sponsors: Array<Awaited<ReturnType<typeof prisma.eventureEventSponsor.findMany>>[number] & {
    sponsorOrganizationName: string | null;
  }>;
  participants: Awaited<ReturnType<typeof prisma.eventureParticipant.findMany>>;
  attendeeSlots: Awaited<ReturnType<typeof prisma.eventureAttendeeSlot.findMany>>;
  followUps: Awaited<ReturnType<typeof prisma.eventureSponsorFollowUp.findMany>>;
  payments: Awaited<ReturnType<typeof prisma.eventurePayment.findMany>>;
  paymentTransactions: Awaited<ReturnType<typeof prisma.eventurePaymentTransaction.findMany>>;
  importRows: Awaited<ReturnType<typeof prisma.eventureImportRow.findMany>>;
};

type CanonicalSponsorClassification =
  | "PROSPECT"
  | "COMMITTED"
  | "INVOICED"
  | "PARTIALLY_PAID"
  | "PAID"
  | "COMPED"
  | "CANCELLED"
  | "UNKNOWN";

type CanonicalPaymentStatus = "PENDING" | "COMPLETED" | "VOIDED" | "FAILED" | "UNKNOWN";

function normalizeValue(value?: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

function toIsoString(value?: Date | null): string | undefined {
  if (!value) return undefined;
  return value.toISOString();
}

function parseAmount(value?: number | null): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

function mapPaymentTransactionStatus(status?: string | null): CanonicalPaymentStatus {
  const normalized = normalizeValue(status);
  if (["completed", "complete", "confirmed", "paid", "succeeded", "success"].includes(normalized)) return "COMPLETED";
  if (["voided", "void", "reversed"].includes(normalized)) return "VOIDED";
  if (["failed", "declined", "error"].includes(normalized)) return "FAILED";
  if (["pending", "processing", "authorized"].includes(normalized)) return "PENDING";
  return "UNKNOWN";
}

function mapSponsorClassification(input: {
  paymentStatus?: string | null;
  committedAmount?: number | null;
  amountPaid?: number | null;
  statusRaw?: string | null;
}): CanonicalSponsorClassification {
  const paymentStatus = normalizeValue(input.paymentStatus);
  const statusRaw = normalizeValue(input.statusRaw);
  const committedAmount = parseAmount(input.committedAmount);
  const amountPaid = parseAmount(input.amountPaid);

  if (["cancelled", "canceled"].includes(statusRaw) || ["cancelled", "canceled"].includes(paymentStatus)) return "CANCELLED";
  if (["comped", "complimentary", "not_applicable"].includes(paymentStatus)) return "COMPED";
  if (amountPaid > 0 && committedAmount > 0 && amountPaid < committedAmount) return "PARTIALLY_PAID";
  if (committedAmount > 0 && amountPaid >= committedAmount) return "PAID";
  if (["paid", "confirmed", "payment confirmed"].includes(paymentStatus)) return "PAID";
  if (["invoiced", "invoice_needed"].includes(paymentStatus)) return "INVOICED";
  if (committedAmount > 0) return "COMMITTED";
  if (["pending_event_payment", "unpaid", "pending"].includes(paymentStatus)) return "COMMITTED";
  if (paymentStatus.length > 0 && paymentStatus !== "unknown") return "COMMITTED";
  if (!paymentStatus || paymentStatus === "unknown") return "UNKNOWN";
  return "PROSPECT";
}

function shouldIncludeArchived(filters: EventReportFilters): boolean {
  return filters.includeArchived === true;
}

function toDateOrUndefined(value?: string): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function transactionIsIncludedByDateRange(transactionAt: Date, filters: EventReportFilters): boolean {
  const from = toDateOrUndefined(filters.dateFrom);
  const to = toDateOrUndefined(filters.dateTo);
  if (from && transactionAt < from) return false;
  if (to && transactionAt > to) return false;
  return true;
}

function getOpenFollowUpCount(followUps: ReportContext["followUps"]): number {
  return followUps.filter((followUp) => {
    const status = normalizeValue(followUp.status);
    return status === "open" || status === "in_progress";
  }).length;
}

function createEnvelope<TTotals extends Record<string, unknown>, TRecord = Record<string, unknown>>(input: {
  eventId: string;
  filters: EventReportFilters;
  totals: TTotals;
  records: TRecord[];
  exceptions: EventReportException[];
  context: ReportContext;
}): EventReportEnvelope<TTotals, TRecord> {
  const latestPaymentAt = input.context.paymentTransactions
    .map((transaction) => transaction.transactionAt)
    .sort((left, right) => right.getTime() - left.getTime())[0];
  const latestImportAt = input.context.importRows
    .map((row) => row.createdAt)
    .sort((left, right) => right.getTime() - left.getTime())[0];
  const latestParticipantUpdateAt = input.context.participants
    .map((participant) => participant.updatedAt)
    .sort((left, right) => right.getTime() - left.getTime())[0];

  return {
    generatedAt: new Date().toISOString(),
    eventId: input.eventId,
    filters: input.filters,
    totals: input.totals,
    records: input.records,
    exceptions: input.exceptions,
    dataFreshness: {
      latestPaymentAt: toIsoString(latestPaymentAt),
      latestImportAt: toIsoString(latestImportAt),
      latestParticipantUpdateAt: toIsoString(latestParticipantUpdateAt),
    },
  };
}

async function loadContext(organizationId: string, eventId: string, filters: EventReportFilters): Promise<ReportContext> {
  const includeArchived = shouldIncludeArchived(filters);
  const companyFilter = filters.companyIds && filters.companyIds.length > 0
    ? { in: filters.companyIds }
    : undefined;

  const [sponsors, participants, attendeeSlots, followUps, payments, paymentTransactions, importRows] = await Promise.all([
    prisma.eventureEventSponsor.findMany({
      where: {
        organizationId,
        eventId,
        ...(includeArchived ? {} : { archivedAt: null }),
        ...(companyFilter ? { sponsorOrganizationId: companyFilter } : {}),
      },
      orderBy: [{ createdAt: "asc" }],
    }),
    prisma.eventureParticipant.findMany({
      where: {
        organizationId,
        eventId,
        ...(companyFilter ? { contactCompanyId: companyFilter } : {}),
        ...(filters.flight && filters.flight !== "UNASSIGNED" ? { flightAssignment: filters.flight } : {}),
      },
      orderBy: [{ createdAt: "asc" }],
    }),
    prisma.eventureAttendeeSlot.findMany({
      where: {
        organizationId,
        eventId,
      },
      orderBy: [{ createdAt: "asc" }],
    }),
    prisma.eventureSponsorFollowUp.findMany({
      where: {
        organizationId,
        eventId,
        ...(includeArchived ? {} : { archivedAt: null }),
        ...(companyFilter ? { sponsorOrganizationId: companyFilter } : {}),
      },
      orderBy: [{ createdAt: "asc" }],
    }),
    prisma.eventurePayment.findMany({
      where: {
        organizationId,
        eventId,
        ...(companyFilter ? { contactCompanyId: companyFilter } : {}),
      },
      orderBy: [{ createdAt: "asc" }],
    }),
    prisma.eventurePaymentTransaction.findMany({
      where: {
        organizationId,
        eventId,
        ...(companyFilter ? { contactCompanyId: companyFilter } : {}),
      },
      orderBy: [{ transactionAt: "asc" }],
    }),
    prisma.eventureImportRow.findMany({
      where: {
        organizationId,
        eventId,
      },
      orderBy: [{ createdAt: "asc" }],
    }),
  ]);

  const organizationIds = Array.from(new Set(sponsors.map((sponsor) => sponsor.sponsorOrganizationId).filter(Boolean)));
  const organizations = organizationIds.length > 0
    ? await prisma.eventureSponsorOrganization.findMany({
      where: {
        organizationId,
        id: { in: organizationIds },
      },
      select: {
        id: true,
        name: true,
      },
    })
    : [];

  const filteredTransactions = paymentTransactions.filter((transaction) => {
    if (filters.source && filters.source.length > 0 && !filters.source.map(normalizeValue).includes(normalizeValue(transaction.source))) {
      return false;
    }

    if (filters.paymentStatus && filters.paymentStatus.length > 0) {
      const accepted = filters.paymentStatus.map((status) => normalizeValue(status));
      const current = normalizeValue(mapPaymentTransactionStatus(transaction.status));
      if (!accepted.includes(current)) return false;
    }

    return transactionIsIncludedByDateRange(transaction.transactionAt, filters);
  });

  const orgMap = new Map(organizations.map((org) => [org.id, org.name]));
  const sponsorsWithOrg = sponsors.map((sponsor) => ({
    ...sponsor,
    sponsorOrganizationName: orgMap.get(sponsor.sponsorOrganizationId) ?? null,
  }));

  return {
    sponsors: sponsorsWithOrg,
    participants,
    attendeeSlots,
    followUps,
    payments,
    paymentTransactions: filteredTransactions,
    importRows,
  };
}

function buildDataQualityExceptions(context: ReportContext): EventReportException[] {
  const exceptions: EventReportException[] = [];

  for (const sponsor of context.sponsors) {
    const classification = mapSponsorClassification({
      paymentStatus: sponsor.paymentStatus,
      committedAmount: sponsor.committedAmount,
      amountPaid: sponsor.amountPaid,
      statusRaw: sponsor.statusRaw,
    });

    if (classification === "UNKNOWN") {
      exceptions.push({
        severity: "HIGH",
        recordType: "SPONSOR",
        recordId: sponsor.id,
        recordName: sponsor.sponsorOrganizationName ?? "Unknown Sponsor",
        reason: "Sponsor payment/commitment status could not be classified.",
        suggestedAction: "Review raw imported status and map to canonical classification.",
        openRecordAction: { type: "sponsor", id: sponsor.id },
        resolveAction: { type: "classify_sponsor", id: sponsor.id },
      });
    }

    const expectedAmount = parseAmount(sponsor.committedAmount);
    if (classification !== "COMPED" && classification !== "CANCELLED" && expectedAmount <= 0) {
      exceptions.push({
        severity: "MEDIUM",
        recordType: "SPONSOR",
        recordId: sponsor.id,
        recordName: sponsor.sponsorOrganizationName ?? "Unknown Sponsor",
        reason: "Missing expected commitment amount.",
        suggestedAction: "Set expected amount from package or approved commitment.",
        openRecordAction: { type: "sponsor", id: sponsor.id },
        resolveAction: { type: "set_expected_amount", id: sponsor.id },
      });
    }
  }

  const sponsorCompanyIds = new Set(context.sponsors.map((sponsor) => sponsor.sponsorOrganizationId));
  for (const transaction of context.paymentTransactions) {
    const canonicalTransactionStatus = mapPaymentTransactionStatus(transaction.status);
    if (canonicalTransactionStatus !== "COMPLETED") continue;
    if (!sponsorCompanyIds.has(transaction.contactCompanyId)) {
      exceptions.push({
        severity: "HIGH",
        recordType: "PAYMENT_TRANSACTION",
        recordId: transaction.id,
        recordName: transaction.referenceKey || transaction.id,
        reason: "Completed payment exists without a mapped sponsor commitment.",
        suggestedAction: "Map payment to commitment or create commitment record.",
        openRecordAction: { type: "payment_transaction", id: transaction.id },
        resolveAction: { type: "map_payment", id: transaction.id },
      });
    }
  }

  const sponsorByCompanyId = new Map(context.sponsors.map((sponsor) => [sponsor.sponsorOrganizationId, sponsor]));
  for (const participant of context.participants) {
    if (sponsorByCompanyId.has(participant.contactCompanyId)) continue;
    exceptions.push({
      severity: "MEDIUM",
      recordType: "PARTICIPANT",
      recordId: participant.id,
      recordName: participant.companyName,
      reason: "Participant exists without sponsor commitment.",
      suggestedAction: "Link participant to sponsor commitment or create one.",
      openRecordAction: { type: "participant", id: participant.id },
      resolveAction: { type: "link_participant_commitment", id: participant.id },
    });
  }

  const slotCountByParticipant = new Map<string, number>();
  for (const slot of context.attendeeSlots) {
    slotCountByParticipant.set(slot.participantId, (slotCountByParticipant.get(slot.participantId) ?? 0) + 1);
  }

  for (const participant of context.participants) {
    const actualSlotCount = slotCountByParticipant.get(participant.id) ?? 0;
    if (actualSlotCount !== participant.attendeeCount) {
      exceptions.push({
        severity: "LOW",
        recordType: "PARTICIPANT",
        recordId: participant.id,
        recordName: participant.companyName,
        reason: `Participant attendee slot mismatch. expected=${participant.attendeeCount}, actual=${actualSlotCount}.`,
        suggestedAction: "Reconcile attendee slots with purchased/assigned counts.",
        openRecordAction: { type: "participant", id: participant.id },
        resolveAction: { type: "reconcile_slots", id: participant.id },
      });
    }
  }

  return exceptions;
}

function buildFinancialTotals(context: ReportContext): {
  expectedRevenue: number;
  collectedRevenue: number;
  refundedAmount: number;
  outstandingRevenue: number;
  availableBalance: number;
  collectionRate: number;
} {
  const exceptions = buildDataQualityExceptions(context);
  const unknownSponsorIds = new Set(
    exceptions
      .filter((issue) => issue.recordType === "SPONSOR" && issue.reason.toLowerCase().includes("could not be classified"))
      .map((issue) => issue.recordId),
  );

  const eligibleSponsors = context.sponsors.filter((sponsor) => !unknownSponsorIds.has(sponsor.id));
  const expectedRevenue = eligibleSponsors.reduce((sum, sponsor) => sum + parseAmount(sponsor.committedAmount), 0);

  let paymentCredits = 0;
  let refundDebits = 0;

  for (const transaction of context.paymentTransactions) {
    if (mapPaymentTransactionStatus(transaction.status) !== "COMPLETED") continue;
    const amount = parseAmount(transaction.totalAmount);
    const type = normalizeValue(transaction.transactionType);
    if (type === "refund") {
      refundDebits += amount;
    } else {
      paymentCredits += amount;
    }
  }

  const collectedRevenue = Math.max(0, paymentCredits - refundDebits);
  const outstandingRevenue = Math.max(0, expectedRevenue - collectedRevenue);
  const availableBalance = collectedRevenue;
  const collectionRate = expectedRevenue > 0 ? collectedRevenue / expectedRevenue : 0;

  return {
    expectedRevenue,
    collectedRevenue,
    refundedAmount: refundDebits,
    outstandingRevenue,
    availableBalance,
    collectionRate,
  };
}

export class EventReportingService {
  static async getSummary(organizationId: string, eventId: string, filters: EventReportFilters) {
    const context = await loadContext(organizationId, eventId, filters);
    const exceptions = buildDataQualityExceptions(context);
    const financialTotals = buildFinancialTotals(context);

    const paidSponsors = context.sponsors.filter((sponsor) => mapSponsorClassification({
      paymentStatus: sponsor.paymentStatus,
      committedAmount: sponsor.committedAmount,
      amountPaid: sponsor.amountPaid,
      statusRaw: sponsor.statusRaw,
    }) === "PAID").length;

    const paidParticipants = context.participants.filter((participant) => participant.paymentConfirmed).length;
    const totalAttendeeSlots = context.attendeeSlots.length;
    const namedAttendees = context.attendeeSlots.filter((slot) => Boolean(slot.actualName?.trim())).length;

    return createEnvelope({
      eventId,
      filters,
      totals: {
        expectedRevenue: financialTotals.expectedRevenue,
        collectedRevenue: financialTotals.collectedRevenue,
        outstandingRevenue: financialTotals.outstandingRevenue,
        collectionRate: financialTotals.collectionRate,
        committedCompanies: context.sponsors.length,
        paidSponsors,
        paidParticipants,
        attendeeSlots: totalAttendeeSlots,
        namedAttendees,
        missingAttendeeNames: Math.max(0, totalAttendeeSlots - namedAttendees),
        openCriticalFollowUps: getOpenFollowUpCount(context.followUps),
      },
      records: context.sponsors.map((sponsor) => ({
        sponsorId: sponsor.id,
        companyId: sponsor.sponsorOrganizationId,
        companyName: sponsor.sponsorOrganizationName ?? "Unknown",
        commitmentAmount: parseAmount(sponsor.committedAmount),
        amountPaid: parseAmount(sponsor.amountPaid),
        classification: mapSponsorClassification({
          paymentStatus: sponsor.paymentStatus,
          committedAmount: sponsor.committedAmount,
          amountPaid: sponsor.amountPaid,
          statusRaw: sponsor.statusRaw,
        }),
      })),
      exceptions,
      context,
    });
  }

  static async getFinancial(organizationId: string, eventId: string, filters: EventReportFilters) {
    const context = await loadContext(organizationId, eventId, filters);
    const exceptions = buildDataQualityExceptions(context);
    const financialTotals = buildFinancialTotals(context);

    const records = context.paymentTransactions.map((transaction) => ({
      transactionId: transaction.id,
      companyId: transaction.contactCompanyId,
      amount: parseAmount(transaction.totalAmount),
      transactionType: transaction.transactionType,
      status: mapPaymentTransactionStatus(transaction.status),
      source: transaction.source,
      method: transaction.paymentMethod,
      receivedAt: toIsoString(transaction.transactionAt),
      referenceNumber: transaction.referenceKey,
    }));

    return createEnvelope({
      eventId,
      filters,
      totals: {
        ...financialTotals,
        transactions: records.length,
      },
      records,
      exceptions,
      context,
    });
  }

  static async getFinancialReconciliation(organizationId: string, eventId: string, filters: EventReportFilters) {
    const context = await loadContext(organizationId, eventId, filters);
    const exceptions = buildDataQualityExceptions(context);

    const paidByCompany = new Map<string, number>();
    for (const transaction of context.paymentTransactions) {
      if (mapPaymentTransactionStatus(transaction.status) !== "COMPLETED") continue;
      const current = paidByCompany.get(transaction.contactCompanyId) ?? 0;
      const direction = normalizeValue(transaction.transactionType) === "refund" ? -1 : 1;
      paidByCompany.set(transaction.contactCompanyId, current + (direction * parseAmount(transaction.totalAmount)));
    }

    const records = context.sponsors.map((sponsor) => {
      const expected = parseAmount(sponsor.committedAmount);
      const collected = paidByCompany.get(sponsor.sponsorOrganizationId) ?? parseAmount(sponsor.amountPaid);
      const difference = expected - collected;
      const status = Math.abs(difference) < 0.01 ? "RECONCILED" : difference > 0 ? "PARTIAL" : "OVERPAID";
      return {
        sponsorId: sponsor.id,
        companyId: sponsor.sponsorOrganizationId,
        companyName: sponsor.sponsorOrganizationName ?? "Unknown",
        expected,
        collected,
        difference,
        status,
      };
    });

    return createEnvelope({
      eventId,
      filters,
      totals: {
        rows: records.length,
        reconciled: records.filter((record) => record.status === "RECONCILED").length,
        partial: records.filter((record) => record.status === "PARTIAL").length,
        overpaid: records.filter((record) => record.status === "OVERPAID").length,
      },
      records,
      exceptions,
      context,
    });
  }

  static async getFinancialAging(organizationId: string, eventId: string, filters: EventReportFilters) {
    const context = await loadContext(organizationId, eventId, filters);
    const exceptions = buildDataQualityExceptions(context);

    const now = Date.now();
    const buckets = {
      notYetDue: 0,
      overdue1to30: 0,
      overdue31to60: 0,
      overdue61to90: 0,
      overdue90Plus: 0,
      noDueDate: 0,
    };

    const records = context.sponsors.map((sponsor) => {
      const expected = parseAmount(sponsor.committedAmount);
      const collected = parseAmount(sponsor.amountPaid);
      const outstanding = Math.max(0, expected - collected);
      const dueDate = sponsor.updatedAt;

      let agingBucket = "no_due_date";
      if (outstanding <= 0) {
        agingBucket = "not_applicable";
      } else if (!dueDate) {
        buckets.noDueDate += outstanding;
      } else {
        const dayDiff = Math.floor((now - dueDate.getTime()) / (1000 * 60 * 60 * 24));
        if (dayDiff <= 0) {
          agingBucket = "not_yet_due";
          buckets.notYetDue += outstanding;
        } else if (dayDiff <= 30) {
          agingBucket = "overdue_1_30";
          buckets.overdue1to30 += outstanding;
        } else if (dayDiff <= 60) {
          agingBucket = "overdue_31_60";
          buckets.overdue31to60 += outstanding;
        } else if (dayDiff <= 90) {
          agingBucket = "overdue_61_90";
          buckets.overdue61to90 += outstanding;
        } else {
          agingBucket = "overdue_90_plus";
          buckets.overdue90Plus += outstanding;
        }
      }

      return {
        sponsorId: sponsor.id,
        companyId: sponsor.sponsorOrganizationId,
        companyName: sponsor.sponsorOrganizationName ?? "Unknown",
        expected,
        collected,
        outstanding,
        agingBucket,
      };
    });

    return createEnvelope({
      eventId,
      filters,
      totals: buckets,
      records,
      exceptions,
      context,
    });
  }

  static async getDataQuality(organizationId: string, eventId: string, filters: EventReportFilters) {
    const context = await loadContext(organizationId, eventId, filters);
    const exceptions = buildDataQualityExceptions(context);

    return createEnvelope({
      eventId,
      filters,
      totals: {
        totalIssues: exceptions.length,
        critical: exceptions.filter((issue) => issue.severity === "CRITICAL").length,
        high: exceptions.filter((issue) => issue.severity === "HIGH").length,
        medium: exceptions.filter((issue) => issue.severity === "MEDIUM").length,
        low: exceptions.filter((issue) => issue.severity === "LOW").length,
      },
      records: exceptions,
      exceptions,
      context,
    });
  }

  static async getPackages(organizationId: string, eventId: string, filters: EventReportFilters) {
    const summary = await EventReportingService.getSummary(organizationId, eventId, filters);
    return {
      ...summary,
      totals: {
        ...summary.totals,
        note: "Package report scaffolding in progress.",
      },
      records: [],
    };
  }

  static async getParticipants(organizationId: string, eventId: string, filters: EventReportFilters) {
    const context = await loadContext(organizationId, eventId, filters);
    const exceptions = buildDataQualityExceptions(context);

    const slotCountByParticipant = new Map<string, number>();
    const namedCountByParticipant = new Map<string, number>();
    for (const slot of context.attendeeSlots) {
      slotCountByParticipant.set(slot.participantId, (slotCountByParticipant.get(slot.participantId) ?? 0) + 1);
      if (slot.actualName?.trim()) {
        namedCountByParticipant.set(slot.participantId, (namedCountByParticipant.get(slot.participantId) ?? 0) + 1);
      }
    }

    const records = context.participants.map((participant) => {
      const slotsAssigned = slotCountByParticipant.get(participant.id) ?? 0;
      const namesAssigned = namedCountByParticipant.get(participant.id) ?? 0;
      return {
        participantId: participant.id,
        companyId: participant.contactCompanyId,
        companyName: participant.companyName,
        paymentConfirmed: participant.paymentConfirmed,
        flight: participant.flightAssignment,
        slotsPurchased: participant.attendeeCount,
        slotsAssigned,
        namesMissing: Math.max(0, slotsAssigned - namesAssigned),
      };
    });

    return createEnvelope({
      eventId,
      filters,
      totals: {
        totalParticipants: records.length,
        paidParticipants: records.filter((record) => record.paymentConfirmed).length,
      },
      records,
      exceptions,
      context,
    });
  }

  static async getAttendees(organizationId: string, eventId: string, filters: EventReportFilters) {
    const context = await loadContext(organizationId, eventId, filters);
    const exceptions = buildDataQualityExceptions(context);

    const records = context.attendeeSlots.map((slot) => ({
      attendeeSlotId: slot.id,
      participantId: slot.participantId,
      companyName: slot.companyName,
      slotNumber: slot.slotNumber,
      isNamed: Boolean(slot.actualName?.trim()),
      name: slot.actualName ?? slot.displayName,
      flight: slot.flightAssignment,
      checkedIn: slot.checkedIn,
    }));

    return createEnvelope({
      eventId,
      filters,
      totals: {
        totalSlots: records.length,
        namedSlots: records.filter((record) => record.isNamed).length,
        checkedIn: records.filter((record) => record.checkedIn).length,
      },
      records,
      exceptions,
      context,
    });
  }

  static async getFlights(organizationId: string, eventId: string, filters: EventReportFilters) {
    const attendees = await EventReportingService.getAttendees(organizationId, eventId, filters);
    const am = attendees.records.filter((record) => normalizeValue(record.flight) === "am");
    const pm = attendees.records.filter((record) => normalizeValue(record.flight) === "pm");
    const unassigned = attendees.records.filter((record) => !["am", "pm"].includes(normalizeValue(record.flight)));

    return {
      ...attendees,
      totals: {
        amSlots: am.length,
        pmSlots: pm.length,
        unassignedSlots: unassigned.length,
      },
      records: [
        { flight: "AM", slots: am.length, named: am.filter((record) => record.isNamed).length },
        { flight: "PM", slots: pm.length, named: pm.filter((record) => record.isNamed).length },
        { flight: "UNASSIGNED", slots: unassigned.length, named: unassigned.filter((record) => record.isNamed).length },
      ],
    };
  }

  static async getCheckIns(organizationId: string, eventId: string, filters: EventReportFilters) {
    const attendees = await EventReportingService.getAttendees(organizationId, eventId, filters);
    const total = attendees.records.length;
    const checkedIn = attendees.records.filter((record) => record.checkedIn).length;

    return {
      ...attendees,
      totals: {
        total,
        checkedIn,
        checkInRate: total > 0 ? checkedIn / total : 0,
      },
    };
  }

  static async getFollowUps(organizationId: string, eventId: string, filters: EventReportFilters) {
    const context = await loadContext(organizationId, eventId, filters);
    const exceptions = buildDataQualityExceptions(context);

    const records = context.followUps.map((followUp) => ({
      followUpId: followUp.id,
      sponsorId: followUp.eventSponsorId,
      companyId: followUp.sponsorOrganizationId,
      type: followUp.type,
      title: followUp.title,
      status: followUp.status,
      assignedTo: followUp.assignedToName,
      dueDate: toIsoString(followUp.dueDate),
    }));

    return createEnvelope({
      eventId,
      filters,
      totals: {
        open: records.filter((record) => ["open", "in_progress"].includes(normalizeValue(record.status))).length,
        closed: records.filter((record) => !["open", "in_progress"].includes(normalizeValue(record.status))).length,
      },
      records,
      exceptions,
      context,
    });
  }
}
