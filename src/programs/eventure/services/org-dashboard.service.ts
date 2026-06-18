import { prisma } from "../../../core/db/prisma.js";
import { isEligiblePaymentStatus } from "./participant-eligibility.service.js";

type DashboardThresholds = {
  paymentCollectionRate: number;
  attendeeNamingRate: number;
  assignmentCompletionRate: number;
  volunteerCoverageRate: number;
  logoCompletionRate: number;
  contactVerificationRate: number;
};

export type EventureProgramDashboardSummary = {
  generatedAt: string;
  activeEvents: {
    count: number;
    nextEvent: {
      id: string;
      name: string;
      startsAt: string;
      daysRemaining: number;
    } | null;
    withinThirtyDays: number;
  };
  financials: {
    expectedRevenue: number;
    grossCollected: number;
    refunds: number;
    netCollected: number;
    outstanding: number;
    collectionRate: number;
    participantsWithBalances: number;
  };
  participation: {
    companyParticipants: number;
    individualParticipants: number;
    totalParticipants: number;
    namedAttendees: number;
    totalSlots: number;
    unnamedSlots: number;
    volunteers: number | null;
    personnelAssigned: number | null;
  };
  attentionItems: {
    upcomingEvents: number;
    unassignedSlots: number;
    companiesMissingContacts: number;
    duplicateRecords: number;
    unmatchedPayments: number;
  };
  nextEventReadiness: {
    eventId: string;
    eventName: string;
    eventDate: string;
    daysRemaining: number;
    paymentsCollectedPct: number;
    attendeeNamingPct: number;
    assignmentCompletionPct: number;
    volunteerCoveragePct: number | null;
    logoCompletionPct: number;
    contactVerificationPct: number;
    links: {
      payments: string;
      attendees: string;
      assignments: string;
      volunteers: string;
      sponsors: string;
      contacts: string;
    };
  } | null;
  eventPerformance: Array<{
    eventId: string;
    eventName: string;
    eventDate: string;
    participants: number;
    expectedRevenue: number;
    collectedRevenue: number;
    outstandingBalance: number;
    namedSlots: number;
    totalSlots: number;
    status: "On Track" | "Attention" | "Critical" | "Completed";
  }>;
  revenueTrend: Array<{
    period: string;
    collected: number;
  }>;
  packagePerformance: Array<{
    packageId: string;
    packageName: string;
    eventId: string;
    eventName: string;
    sold: number;
    capacity: number | null;
    revenue: number;
    remainingAvailability: number | null;
  }>;
  recentActivity: Array<{
    id: string;
    type: string;
    title: string;
    eventId: string | null;
    eventName: string | null;
    occurredAt: string;
  }>;
  partialDataWarnings: string[];
};

const ACTIVE_EVENT_STATUSES = new Set([
  "active",
  "live",
  "open",
  "published",
  "submitted",
  "in_progress",
]);

const COMPLETED_EVENT_STATUSES = new Set(["completed", "closed", "reconciled"]);

const DEFAULT_THRESHOLDS: DashboardThresholds = {
  paymentCollectionRate: 0.8,
  attendeeNamingRate: 0.8,
  assignmentCompletionRate: 0.75,
  volunteerCoverageRate: 0.75,
  logoCompletionRate: 0.8,
  contactVerificationRate: 0.9,
};

function normalizeValue(value?: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

function parseAmount(value?: number | null): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

function parseDate(value?: string | Date | null): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function clampRate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function calculateRate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return clampRate(numerator / denominator);
}

function getDaysRemaining(startsAt: Date, now: Date): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.ceil((startsAt.getTime() - now.getTime()) / msPerDay);
}

function isActiveEvent(event: { status: string; startDateTime: Date; endDateTime: Date }, now: Date): boolean {
  const normalized = normalizeValue(event.status);
  if (ACTIVE_EVENT_STATUSES.has(normalized)) return true;
  if (COMPLETED_EVENT_STATUSES.has(normalized)) return false;
  return event.endDateTime.getTime() >= now.getTime();
}

function isCompletedEventStatus(status: string): boolean {
  return COMPLETED_EVENT_STATUSES.has(normalizeValue(status));
}

function isCompletedTransactionStatus(status?: string | null): boolean {
  const normalized = normalizeValue(status);
  return ["completed", "confirmed", "paid", "succeeded", "success", "complete"].includes(normalized);
}

function isRefundTransactionType(type?: string | null): boolean {
  const normalized = normalizeValue(type);
  return ["refund", "reversal", "chargeback"].includes(normalized);
}

function dedupeTransactionKey(transaction: {
  id: string;
  referenceKey: string | null;
  contactCompanyId: string;
  transactionType: string;
  totalAmount: number;
  transactionAt: Date;
}): string {
  if (transaction.referenceKey?.trim()) {
    return `ref:${normalizeValue(transaction.referenceKey)}:${normalizeValue(transaction.transactionType)}`;
  }

  return [
    "fallback",
    transaction.contactCompanyId,
    normalizeValue(transaction.transactionType),
    parseAmount(transaction.totalAmount).toFixed(2),
    transaction.transactionAt.toISOString(),
  ].join("|");
}

function getEventNameById(events: Array<{ id: string; title: string }>): Map<string, string> {
  return new Map(events.map((event) => [event.id, event.title]));
}

function hasUsableContact(input: {
  mainEmail?: string | null;
  mainPhone?: string | null;
  contacts?: Array<{ isPrimary: boolean; email?: string | null; phone?: string | null }>;
}): boolean {
  if (input.mainEmail?.trim() || input.mainPhone?.trim()) return true;
  const primary = (input.contacts ?? []).filter((item) => item.isPrimary);
  if (primary.some((item) => item.email?.trim() || item.phone?.trim())) return true;
  return (input.contacts ?? []).some((item) => item.email?.trim() || item.phone?.trim());
}

function readNumberField(source: Record<string, unknown>, field: string): number | undefined {
  const value = source[field];
  return typeof value === "number" && Number.isFinite(value) ? Number(value) : undefined;
}

function resolveThresholds(
  orgSettings: Record<string, unknown>,
  eventExtendedInfo: unknown,
): DashboardThresholds {
  const merged = {
    ...DEFAULT_THRESHOLDS,
  };

  const orgTargets = typeof orgSettings.dashboardThresholds === "object" && orgSettings.dashboardThresholds
    ? (orgSettings.dashboardThresholds as Record<string, unknown>)
    : {};

  const eventInfo = typeof eventExtendedInfo === "object" && eventExtendedInfo
    ? (eventExtendedInfo as Record<string, unknown>)
    : {};

  const eventTargets = typeof eventInfo.dashboardThresholds === "object" && eventInfo.dashboardThresholds
    ? (eventInfo.dashboardThresholds as Record<string, unknown>)
    : {};

  const sources = [orgTargets, eventTargets];

  for (const source of sources) {
    const paymentCollectionRate = readNumberField(source, "paymentCollectionRate");
    const attendeeNamingRate = readNumberField(source, "attendeeNamingRate");
    const assignmentCompletionRate = readNumberField(source, "assignmentCompletionRate");
    const volunteerCoverageRate = readNumberField(source, "volunteerCoverageRate");
    const logoCompletionRate = readNumberField(source, "logoCompletionRate");
    const contactVerificationRate = readNumberField(source, "contactVerificationRate");

    if (paymentCollectionRate !== undefined) merged.paymentCollectionRate = clampRate(paymentCollectionRate);
    if (attendeeNamingRate !== undefined) merged.attendeeNamingRate = clampRate(attendeeNamingRate);
    if (assignmentCompletionRate !== undefined) merged.assignmentCompletionRate = clampRate(assignmentCompletionRate);
    if (volunteerCoverageRate !== undefined) merged.volunteerCoverageRate = clampRate(volunteerCoverageRate);
    if (logoCompletionRate !== undefined) merged.logoCompletionRate = clampRate(logoCompletionRate);
    if (contactVerificationRate !== undefined) merged.contactVerificationRate = clampRate(contactVerificationRate);
  }

  return merged;
}

function classifyEventStatus(input: {
  eventStatus: string;
  daysRemaining: number;
  paymentCollectionPct: number;
  attendeeNamingPct: number;
  assignmentCompletionPct: number;
  volunteerCoveragePct: number | null;
  logoCompletionPct: number;
  contactVerificationPct: number;
  thresholds: DashboardThresholds;
}): "On Track" | "Attention" | "Critical" | "Completed" {
  if (isCompletedEventStatus(input.eventStatus) || input.daysRemaining < 0) {
    return "Completed";
  }

  const belowPayment = input.paymentCollectionPct < input.thresholds.paymentCollectionRate;
  const belowNaming = input.attendeeNamingPct < input.thresholds.attendeeNamingRate;
  const belowAssignments = input.assignmentCompletionPct < input.thresholds.assignmentCompletionRate;
  const belowVolunteers = input.volunteerCoveragePct !== null
    ? input.volunteerCoveragePct < input.thresholds.volunteerCoverageRate
    : false;
  const belowLogos = input.logoCompletionPct < input.thresholds.logoCompletionRate;
  const belowContacts = input.contactVerificationPct < input.thresholds.contactVerificationRate;

  const isBelowAny = belowPayment || belowNaming || belowAssignments || belowVolunteers || belowLogos || belowContacts;

  if (!isBelowAny) {
    return "On Track";
  }

  const criticalSignals = [
    input.paymentCollectionPct < 0.55,
    input.attendeeNamingPct < 0.5,
    input.assignmentCompletionPct < 0.5,
    input.volunteerCoveragePct !== null && input.volunteerCoveragePct < 0.45,
  ].some(Boolean);

  if (input.daysRemaining <= 14 && criticalSignals) {
    return "Critical";
  }

  return "Attention";
}

export class OrgDashboardService {
  static async getSummary(organizationId: string): Promise<EventureProgramDashboardSummary> {
    const now = new Date();
    const thirtyDaysFromNow = new Date(now.getTime() + (1000 * 60 * 60 * 24 * 30));

    const [programSettings, events] = await Promise.all([
      prisma.programStorageSettings.findUnique({
        where: {
          organizationId_programDomain: {
            organizationId,
            programDomain: "eventure",
          },
        },
        select: {
          settings: true,
        },
      }),
      prisma.eventureEvent.findMany({
        where: {
          organizationId,
          archivedAt: null,
        },
        select: {
          id: true,
          title: true,
          status: true,
          startDateTime: true,
          endDateTime: true,
          extendedInfo: true,
        },
        orderBy: [{ startDateTime: "asc" }],
      }),
    ]);

    const activeEvents = events.filter((event) => isActiveEvent(event, now));
    const activeEventIds = activeEvents.map((event) => event.id);
    const eventNameById = getEventNameById(activeEvents);

    const orgSettings = (programSettings?.settings && typeof programSettings.settings === "object")
      ? (programSettings.settings as Record<string, unknown>)
      : {};

    if (activeEventIds.length === 0) {
      return {
        generatedAt: now.toISOString(),
        activeEvents: {
          count: 0,
          nextEvent: null,
          withinThirtyDays: 0,
        },
        financials: {
          expectedRevenue: 0,
          grossCollected: 0,
          refunds: 0,
          netCollected: 0,
          outstanding: 0,
          collectionRate: 0,
          participantsWithBalances: 0,
        },
        participation: {
          companyParticipants: 0,
          individualParticipants: 0,
          totalParticipants: 0,
          namedAttendees: 0,
          totalSlots: 0,
          unnamedSlots: 0,
          volunteers: null,
          personnelAssigned: null,
        },
        attentionItems: {
          upcomingEvents: 0,
          unassignedSlots: 0,
          companiesMissingContacts: 0,
          duplicateRecords: 0,
          unmatchedPayments: 0,
        },
        nextEventReadiness: null,
        eventPerformance: [],
        revenueTrend: [],
        packagePerformance: [],
        recentActivity: [],
        partialDataWarnings: ["No active events found for this organization."],
      };
    }

    const [
      sponsors,
      participants,
      registrations,
      attendeeSlots,
      payments,
      paymentTransactions,
      volunteerNeeds,
      volunteerContacts,
      eventPersonnel,
      importBatches,
      unmatchedRevenue,
      priceOptions,
      participantPackages,
      auditLogs,
    ] = await Promise.all([
      prisma.eventureEventSponsor.findMany({
        where: {
          organizationId,
          eventId: { in: activeEventIds },
          archivedAt: null,
        },
        include: {
          sponsorOrganization: {
            select: {
              id: true,
              name: true,
              normalizedName: true,
              mainEmail: true,
              mainPhone: true,
              logoUrl: true,
              contacts: {
                where: { archivedAt: null },
                select: {
                  isPrimary: true,
                  email: true,
                  phone: true,
                },
              },
            },
          },
        },
      }),
      prisma.eventureParticipant.findMany({
        where: {
          organizationId,
          eventId: { in: activeEventIds },
        },
        select: {
          id: true,
          eventId: true,
          contactCompanyId: true,
          companyName: true,
          paymentConfirmed: true,
          status: true,
          attendeeCount: true,
          flightAssignment: true,
          createdAt: true,
        },
      }),
      prisma.eventureRegistration.findMany({
        where: {
          organizationId,
          eventId: { in: activeEventIds },
        },
        select: {
          id: true,
          eventId: true,
          paymentStatus: true,
          contactCompanyId: true,
          createdAt: true,
        },
      }),
      prisma.eventureAttendeeSlot.findMany({
        where: {
          organizationId,
          eventId: { in: activeEventIds },
        },
        select: {
          id: true,
          eventId: true,
          participantId: true,
          actualName: true,
          flightAssignment: true,
        },
      }),
      prisma.eventurePayment.findMany({
        where: {
          organizationId,
          eventId: { in: activeEventIds },
        },
        select: {
          id: true,
          eventId: true,
          contactCompanyId: true,
          amountDue: true,
          amountPaid: true,
          updatedAt: true,
        },
      }),
      prisma.eventurePaymentTransaction.findMany({
        where: {
          organizationId,
          eventId: { in: activeEventIds },
        },
        select: {
          id: true,
          eventId: true,
          contactCompanyId: true,
          referenceKey: true,
          transactionType: true,
          status: true,
          totalAmount: true,
          transactionAt: true,
          updatedAt: true,
        },
        orderBy: [{ transactionAt: "asc" }],
      }),
      prisma.eventureEventVolunteerNeed.findMany({
        where: {
          organizationId,
          eventId: { in: activeEventIds },
          archivedAt: null,
        },
        select: {
          id: true,
          eventId: true,
          status: true,
        },
      }),
      prisma.eventureEventVolunteerContact.findMany({
        where: {
          organizationId,
          eventId: { in: activeEventIds },
          archivedAt: null,
        },
        select: {
          id: true,
          eventId: true,
        },
      }),
      prisma.eventureEventPersonnel.findMany({
        where: {
          organizationId,
          eventId: { in: activeEventIds },
          archivedAt: null,
        },
        select: {
          id: true,
          eventId: true,
        },
      }),
      prisma.eventureImportBatch.findMany({
        where: {
          organizationId,
          eventId: { in: activeEventIds },
        },
        select: {
          id: true,
          eventId: true,
          status: true,
          fileName: true,
          completedAt: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: "desc" }],
        take: 25,
      }),
      prisma.eventureUnmatchedRevenue.findMany({
        where: {
          organizationId,
          eventId: { in: activeEventIds },
        },
        select: {
          id: true,
          eventId: true,
          status: true,
          createdAt: true,
        },
      }),
      prisma.eventPriceOption.findMany({
        where: {
          organizationId,
          eventId: { in: activeEventIds },
          archivedAt: null,
        },
        select: {
          id: true,
          eventId: true,
          name: true,
          isLimited: true,
        },
      }),
      prisma.eventParticipantPackage.findMany({
        where: {
          organizationId,
          eventId: { in: activeEventIds },
        },
        select: {
          id: true,
          eventId: true,
          priceOptionId: true,
          quantity: true,
          totalPriceCents: true,
        },
      }),
      prisma.eventureAuditLog.findMany({
        where: {
          organizationId,
        },
        select: {
          id: true,
          action: true,
          resourceType: true,
          resourceId: true,
          metadata: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: "desc" }],
        take: 20,
      }),
    ]);

    const activeEventIdSet = new Set(activeEventIds);
    const activeSponsors = sponsors.filter((row) => activeEventIdSet.has(row.eventId));
    const activeParticipants = participants.filter((row) => activeEventIdSet.has(row.eventId));
    const activeRegistrations = registrations.filter((row) => activeEventIdSet.has(row.eventId));
    const activeAttendeeSlots = attendeeSlots.filter((row) => activeEventIdSet.has(row.eventId));
    const activePayments = payments.filter((row) => activeEventIdSet.has(row.eventId));
    const activeTransactions = paymentTransactions.filter((row) => activeEventIdSet.has(row.eventId));
    const activeVolunteerNeeds = volunteerNeeds.filter((row) => activeEventIdSet.has(row.eventId));
    const activeVolunteerContacts = volunteerContacts.filter((row) => activeEventIdSet.has(row.eventId));
    const activeEventPersonnel = eventPersonnel.filter((row) => activeEventIdSet.has(row.eventId));
    const activeImportBatches = importBatches.filter((row) => row.eventId ? activeEventIdSet.has(row.eventId) : true);
    const activeUnmatchedRevenue = unmatchedRevenue.filter((row) => activeEventIdSet.has(row.eventId));
    const activePriceOptions = priceOptions.filter((row) => activeEventIdSet.has(row.eventId));
    const activeParticipantPackages = participantPackages.filter((row) => activeEventIdSet.has(row.eventId));

    const eventFinancials = new Map<string, {
      expected: number;
      grossCollected: number;
      refunds: number;
      netCollected: number;
      outstanding: number;
      participantsWithBalances: number;
    }>();

    const paymentsByEvent = new Map<string, Array<typeof payments[number]>>();
    for (const payment of activePayments) {
      const list = paymentsByEvent.get(payment.eventId) ?? [];
      list.push(payment);
      paymentsByEvent.set(payment.eventId, list);
    }

    const sponsorsByEvent = new Map<string, Array<typeof sponsors[number]>>();
    for (const sponsor of activeSponsors) {
      const list = sponsorsByEvent.get(sponsor.eventId) ?? [];
      list.push(sponsor);
      sponsorsByEvent.set(sponsor.eventId, list);
    }

    const transactionsByEvent = new Map<string, Array<typeof paymentTransactions[number]>>();
    for (const transaction of activeTransactions) {
      const list = transactionsByEvent.get(transaction.eventId) ?? [];
      list.push(transaction);
      transactionsByEvent.set(transaction.eventId, list);
    }

    for (const event of activeEvents) {
      const eventId = event.id;
      const paymentRows = paymentsByEvent.get(eventId) ?? [];
      const sponsorRows = sponsorsByEvent.get(eventId) ?? [];
      const transactionRows = transactionsByEvent.get(eventId) ?? [];

      const latestPaymentByCompany = new Map<string, typeof paymentRows[number]>();
      for (const row of paymentRows) {
        const existing = latestPaymentByCompany.get(row.contactCompanyId);
        if (!existing || row.updatedAt.getTime() > existing.updatedAt.getTime()) {
          latestPaymentByCompany.set(row.contactCompanyId, row);
        }
      }

      const committedByCompany = new Map<string, number>();
      for (const sponsor of sponsorRows) {
        if (!committedByCompany.has(sponsor.sponsorOrganizationId)) {
          committedByCompany.set(sponsor.sponsorOrganizationId, parseAmount(sponsor.committedAmount));
        }
      }

      const expectedByCompany = new Map<string, number>();
      for (const [companyId, amount] of committedByCompany.entries()) {
        expectedByCompany.set(companyId, amount);
      }
      for (const [companyId, payment] of latestPaymentByCompany.entries()) {
        expectedByCompany.set(companyId, parseAmount(payment.amountDue));
      }

      const dedupeKeys = new Set<string>();
      let grossCollected = 0;
      let refunds = 0;
      for (const transaction of transactionRows) {
        if (!isCompletedTransactionStatus(transaction.status)) continue;
        const key = dedupeTransactionKey(transaction);
        if (dedupeKeys.has(key)) continue;
        dedupeKeys.add(key);

        const amount = parseAmount(transaction.totalAmount);
        if (isRefundTransactionType(transaction.transactionType)) {
          refunds += amount;
        } else {
          grossCollected += amount;
        }
      }

      const fallbackCollected = Array.from(latestPaymentByCompany.values()).reduce((sum, row) => sum + parseAmount(row.amountPaid), 0);
      if (grossCollected === 0 && refunds === 0 && fallbackCollected > 0) {
        grossCollected = fallbackCollected;
      }

      const expected = Array.from(expectedByCompany.values()).reduce((sum, amount) => sum + amount, 0);
      const netCollected = Math.max(0, grossCollected - refunds);
      const outstanding = Math.max(0, expected - netCollected);

      let participantsWithBalances = 0;
      for (const [companyId, expectedAmount] of expectedByCompany.entries()) {
        const paidAmount = latestPaymentByCompany.get(companyId)
          ? parseAmount(latestPaymentByCompany.get(companyId)?.amountPaid)
          : 0;
        if (expectedAmount > paidAmount + 0.01) {
          participantsWithBalances += 1;
        }
      }

      eventFinancials.set(eventId, {
        expected,
        grossCollected,
        refunds,
        netCollected,
        outstanding,
        participantsWithBalances,
      });
    }

    const eventParticipants = new Map<string, Array<typeof participants[number]>>();
    for (const participant of activeParticipants) {
      const list = eventParticipants.get(participant.eventId) ?? [];
      list.push(participant);
      eventParticipants.set(participant.eventId, list);
    }

    const slotsByEvent = new Map<string, Array<typeof attendeeSlots[number]>>();
    for (const slot of activeAttendeeSlots) {
      const list = slotsByEvent.get(slot.eventId) ?? [];
      list.push(slot);
      slotsByEvent.set(slot.eventId, list);
    }

    const volunteerNeedsByEvent = new Map<string, Array<typeof volunteerNeeds[number]>>();
    for (const need of activeVolunteerNeeds) {
      const list = volunteerNeedsByEvent.get(need.eventId) ?? [];
      list.push(need);
      volunteerNeedsByEvent.set(need.eventId, list);
    }

    const volunteerContactsByEvent = new Map<string, Array<typeof volunteerContacts[number]>>();
    for (const volunteer of activeVolunteerContacts) {
      const list = volunteerContactsByEvent.get(volunteer.eventId) ?? [];
      list.push(volunteer);
      volunteerContactsByEvent.set(volunteer.eventId, list);
    }

    const personnelByEvent = new Map<string, Array<typeof eventPersonnel[number]>>();
    for (const assignment of activeEventPersonnel) {
      const list = personnelByEvent.get(assignment.eventId) ?? [];
      list.push(assignment);
      personnelByEvent.set(assignment.eventId, list);
    }

    const sponsorsByEventForContacts = new Map<string, Array<typeof sponsors[number]>>();
    for (const sponsor of activeSponsors) {
      const list = sponsorsByEventForContacts.get(sponsor.eventId) ?? [];
      list.push(sponsor);
      sponsorsByEventForContacts.set(sponsor.eventId, list);
    }

    const nextEvent = activeEvents.find((event) => event.startDateTime.getTime() >= now.getTime()) ?? null;
    const withinThirtyDays = activeEvents.filter((event) => {
      const startsAt = event.startDateTime.getTime();
      return startsAt >= now.getTime() && startsAt <= thirtyDaysFromNow.getTime();
    }).length;

    const namedAttendees = activeAttendeeSlots.filter((slot) => Boolean(slot.actualName?.trim())).length;
    const totalSlots = activeAttendeeSlots.length;
    const unnamedSlots = Math.max(0, totalSlots - namedAttendees);

    const eligibleCompanyParticipants = activeParticipants.filter((participant) => {
      return participant.paymentConfirmed || ["confirmed", "active"].includes(normalizeValue(participant.status));
    });

    const eligibleIndividualParticipants = activeRegistrations.filter((registration) => {
      return !registration.contactCompanyId && isEligiblePaymentStatus(registration.paymentStatus);
    });

    const participatingCompanyIds = new Set(eligibleCompanyParticipants.map((item) => item.contactCompanyId));
    const companySponsorRows = activeSponsors.filter((sponsor) => participatingCompanyIds.has(sponsor.sponsorOrganizationId));

    const companyMissingContacts = new Set<string>();
    for (const sponsor of companySponsorRows) {
      if (!hasUsableContact({
        mainEmail: sponsor.sponsorOrganization.mainEmail,
        mainPhone: sponsor.sponsorOrganization.mainPhone,
        contacts: sponsor.sponsorOrganization.contacts,
      })) {
        companyMissingContacts.add(sponsor.sponsorOrganizationId);
      }
    }

    for (const companyId of participatingCompanyIds) {
      if (!companySponsorRows.some((sponsor) => sponsor.sponsorOrganizationId === companyId)) {
        companyMissingContacts.add(companyId);
      }
    }

    const duplicateCompanyRecords = (() => {
      const counts = new Map<string, number>();
      for (const sponsor of companySponsorRows) {
        const key = normalizeValue(sponsor.sponsorOrganization.normalizedName || sponsor.sponsorOrganization.name);
        if (!key) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      let total = 0;
      for (const count of counts.values()) {
        if (count > 1) total += count - 1;
      }
      return total;
    })();

    const duplicateAttendeeRecords = (() => {
      const counts = new Map<string, number>();
      for (const slot of activeAttendeeSlots) {
        const key = normalizeValue(slot.actualName);
        if (!key) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      let total = 0;
      for (const count of counts.values()) {
        if (count > 1) total += count - 1;
      }
      return total;
    })();

    const unmatchedPayments = activeUnmatchedRevenue.filter((item) => normalizeValue(item.status) === "unmatched").length;

    const allFinancials = Array.from(eventFinancials.values());
    const expectedRevenue = allFinancials.reduce((sum, item) => sum + item.expected, 0);
    const grossCollected = allFinancials.reduce((sum, item) => sum + item.grossCollected, 0);
    const refunds = allFinancials.reduce((sum, item) => sum + item.refunds, 0);
    const netCollected = Math.max(0, allFinancials.reduce((sum, item) => sum + item.netCollected, 0));
    const outstanding = Math.max(0, expectedRevenue - netCollected);
    const participantsWithBalances = allFinancials.reduce((sum, item) => sum + item.participantsWithBalances, 0);

    const eventPerformance = activeEvents.map((event) => {
      const eventId = event.id;
      const slots = slotsByEvent.get(eventId) ?? [];
      const totalEventSlots = slots.length;
      const namedEventSlots = slots.filter((slot) => Boolean(slot.actualName?.trim())).length;
      const assignmentsComplete = slots.filter((slot) => ["am", "pm"].includes(normalizeValue(slot.flightAssignment))).length;

      const eventVolunteerNeeds = volunteerNeedsByEvent.get(eventId) ?? [];
      const coveredVolunteerNeeds = eventVolunteerNeeds.filter((need) => {
        const status = normalizeValue(need.status);
        return ["covered", "filled", "complete", "assigned"].includes(status);
      }).length;
      const volunteerCoveragePct = eventVolunteerNeeds.length > 0
        ? calculateRate(coveredVolunteerNeeds, eventVolunteerNeeds.length)
        : null;

      const eventSponsors = sponsorsByEventForContacts.get(eventId) ?? [];
      const logosDone = eventSponsors.filter((sponsor) => {
        const status = normalizeValue(sponsor.logoStatus);
        return ["received", "approved", "complete", "completed", "uploaded"].includes(status)
          || Boolean(sponsor.sponsorOrganization.logoUrl?.trim());
      }).length;

      const contactsVerified = eventSponsors.filter((sponsor) => hasUsableContact({
        mainEmail: sponsor.sponsorOrganization.mainEmail,
        mainPhone: sponsor.sponsorOrganization.mainPhone,
        contacts: sponsor.sponsorOrganization.contacts,
      })).length;

      const thresholds = resolveThresholds(orgSettings, event.extendedInfo);
      const financial = eventFinancials.get(eventId) ?? {
        expected: 0,
        grossCollected: 0,
        refunds: 0,
        netCollected: 0,
        outstanding: 0,
        participantsWithBalances: 0,
      };

      const daysRemaining = getDaysRemaining(event.startDateTime, now);
      const paymentCollectionPct = calculateRate(financial.netCollected, financial.expected);
      const attendeeNamingPct = calculateRate(namedEventSlots, totalEventSlots);
      const assignmentCompletionPct = calculateRate(assignmentsComplete, totalEventSlots);
      const logoCompletionPct = calculateRate(logosDone, eventSponsors.length);
      const contactVerificationPct = calculateRate(contactsVerified, eventSponsors.length);

      const status = classifyEventStatus({
        eventStatus: event.status,
        daysRemaining,
        paymentCollectionPct,
        attendeeNamingPct,
        assignmentCompletionPct,
        volunteerCoveragePct,
        logoCompletionPct,
        contactVerificationPct,
        thresholds,
      });

      return {
        eventId,
        eventName: event.title,
        eventDate: event.startDateTime.toISOString(),
        participants: (eventParticipants.get(eventId) ?? []).length,
        expectedRevenue: financial.expected,
        collectedRevenue: financial.netCollected,
        outstandingBalance: financial.outstanding,
        namedSlots: namedEventSlots,
        totalSlots: totalEventSlots,
        status,
      };
    });

    const nextReadiness = nextEvent
      ? (() => {
        const eventId = nextEvent.id;
        const slots = slotsByEvent.get(eventId) ?? [];
        const totalEventSlots = slots.length;
        const namedEventSlots = slots.filter((slot) => Boolean(slot.actualName?.trim())).length;
        const assignmentsComplete = slots.filter((slot) => ["am", "pm"].includes(normalizeValue(slot.flightAssignment))).length;

        const eventVolunteerNeeds = volunteerNeedsByEvent.get(eventId) ?? [];
        const coveredVolunteerNeeds = eventVolunteerNeeds.filter((need) => {
          const status = normalizeValue(need.status);
          return ["covered", "filled", "complete", "assigned"].includes(status);
        }).length;

        const eventSponsors = sponsorsByEventForContacts.get(eventId) ?? [];
        const logosDone = eventSponsors.filter((sponsor) => {
          const status = normalizeValue(sponsor.logoStatus);
          return ["received", "approved", "complete", "completed", "uploaded"].includes(status)
            || Boolean(sponsor.sponsorOrganization.logoUrl?.trim());
        }).length;

        const contactsVerified = eventSponsors.filter((sponsor) => hasUsableContact({
          mainEmail: sponsor.sponsorOrganization.mainEmail,
          mainPhone: sponsor.sponsorOrganization.mainPhone,
          contacts: sponsor.sponsorOrganization.contacts,
        })).length;

        const financial = eventFinancials.get(eventId) ?? {
          expected: 0,
          grossCollected: 0,
          refunds: 0,
          netCollected: 0,
          outstanding: 0,
          participantsWithBalances: 0,
        };

        return {
          eventId,
          eventName: nextEvent.title,
          eventDate: nextEvent.startDateTime.toISOString(),
          daysRemaining: getDaysRemaining(nextEvent.startDateTime, now),
          paymentsCollectedPct: calculateRate(financial.netCollected, financial.expected),
          attendeeNamingPct: calculateRate(namedEventSlots, totalEventSlots),
          assignmentCompletionPct: calculateRate(assignmentsComplete, totalEventSlots),
          volunteerCoveragePct: eventVolunteerNeeds.length > 0
            ? calculateRate(coveredVolunteerNeeds, eventVolunteerNeeds.length)
            : null,
          logoCompletionPct: calculateRate(logosDone, eventSponsors.length),
          contactVerificationPct: calculateRate(contactsVerified, eventSponsors.length),
          links: {
            payments: `/events/${eventId}/payments`,
            attendees: `/events/${eventId}/attendees`,
            assignments: `/events/${eventId}/participants`,
            volunteers: `/events/${eventId}/volunteers`,
            sponsors: `/events/${eventId}/sponsors`,
            contacts: `/events/${eventId}/sponsors`,
          },
        };
      })()
      : null;

    const trendBuckets = new Map<string, number>();
    for (const transaction of activeTransactions) {
      if (!isCompletedTransactionStatus(transaction.status)) continue;
      const monthKey = transaction.transactionAt.toISOString().slice(0, 7);
      const current = trendBuckets.get(monthKey) ?? 0;
      const amount = parseAmount(transaction.totalAmount);
      trendBuckets.set(
        monthKey,
        current + (isRefundTransactionType(transaction.transactionType) ? -amount : amount),
      );
    }

    const revenueTrend = Array.from(trendBuckets.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(-12)
      .map(([period, collected]) => ({
        period,
        collected: Math.max(0, collected),
      }));

    const priceOptionById = new Map(activePriceOptions.map((item) => [item.id, item]));
    const packageRollup = new Map<string, {
      packageId: string;
      packageName: string;
      eventId: string;
      eventName: string;
      sold: number;
      capacity: number | null;
      revenue: number;
      remainingAvailability: number | null;
    }>();

    for (const row of activeParticipantPackages) {
      const option = priceOptionById.get(row.priceOptionId);
      if (!option) continue;
      const key = `${row.eventId}:${row.priceOptionId}`;
      const existing = packageRollup.get(key) ?? {
        packageId: row.priceOptionId,
        packageName: option.name,
        eventId: row.eventId,
        eventName: eventNameById.get(row.eventId) ?? "Unknown Event",
        sold: 0,
        capacity: null,
        revenue: 0,
        remainingAvailability: null,
      };
      existing.sold += row.quantity;
      existing.revenue += parseAmount(row.totalPriceCents) / 100;
      packageRollup.set(key, existing);
    }

    const packagePerformance = Array.from(packageRollup.values())
      .sort((left, right) => right.revenue - left.revenue);

    const recentActivity = [
      ...activeTransactions
        .filter((transaction) => isCompletedTransactionStatus(transaction.status))
        .map((transaction) => ({
          id: `payment:${transaction.id}`,
          type: "payment_confirmed",
          title: `${isRefundTransactionType(transaction.transactionType) ? "Refund recorded" : "Payment confirmed"} - $${parseAmount(transaction.totalAmount).toLocaleString()}`,
          eventId: transaction.eventId,
          eventName: eventNameById.get(transaction.eventId) ?? null,
          occurredAt: transaction.transactionAt.toISOString(),
        })),
      ...activeParticipants.map((participant) => ({
        id: `participant:${participant.id}`,
        type: "participant_added",
        title: `${participant.companyName} participant added`,
        eventId: participant.eventId,
        eventName: eventNameById.get(participant.eventId) ?? null,
        occurredAt: participant.createdAt.toISOString(),
      })),
      ...activeImportBatches.map((batch) => ({
        id: `import:${batch.id}`,
        type: "import_completed",
        title: `${batch.fileName} import ${normalizeValue(batch.status) === "completed" ? "completed" : batch.status}`,
        eventId: batch.eventId ?? null,
        eventName: batch.eventId ? (eventNameById.get(batch.eventId) ?? null) : null,
        occurredAt: (batch.completedAt ?? batch.createdAt).toISOString(),
      })),
      ...auditLogs.map((audit) => ({
        id: `audit:${audit.id}`,
        type: normalizeValue(audit.action) || "record_updated",
        title: `${audit.action.replace(/_/g, " ")} (${audit.resourceType})`,
        eventId: (() => {
          const metadata = audit.metadata && typeof audit.metadata === "object"
            ? (audit.metadata as Record<string, unknown>)
            : {};
          return typeof metadata.eventId === "string" ? metadata.eventId : null;
        })(),
        eventName: (() => {
          const metadata = audit.metadata && typeof audit.metadata === "object"
            ? (audit.metadata as Record<string, unknown>)
            : {};
          const eventId = typeof metadata.eventId === "string" ? metadata.eventId : null;
          return eventId ? (eventNameById.get(eventId) ?? null) : null;
        })(),
        occurredAt: audit.createdAt.toISOString(),
      })),
    ]
      .sort((left, right) => parseDate(right.occurredAt)?.getTime() ?? 0 - (parseDate(left.occurredAt)?.getTime() ?? 0))
      .slice(0, 30);

    const volunteersValue = activeVolunteerContacts.length > 0 ? activeVolunteerContacts.length : null;
    const personnelAssignedValue = activeEventPersonnel.length > 0 ? activeEventPersonnel.length : null;

    const partialDataWarnings: string[] = [];
    if (volunteersValue === null) {
      partialDataWarnings.push("Volunteer assignments are not fully modeled for every event; volunteer totals may be unavailable.");
    }
    if (personnelAssignedValue === null) {
      partialDataWarnings.push("No personnel assignments were found for active events.");
    }
    if (packagePerformance.some((item) => item.capacity === null)) {
      partialDataWarnings.push("Package capacity and remaining availability are unavailable for one or more packages.");
    }

    return {
      generatedAt: now.toISOString(),
      activeEvents: {
        count: activeEvents.length,
        nextEvent: nextEvent
          ? {
            id: nextEvent.id,
            name: nextEvent.title,
            startsAt: nextEvent.startDateTime.toISOString(),
            daysRemaining: getDaysRemaining(nextEvent.startDateTime, now),
          }
          : null,
        withinThirtyDays,
      },
      financials: {
        expectedRevenue,
        grossCollected,
        refunds,
        netCollected,
        outstanding,
        collectionRate: calculateRate(netCollected, expectedRevenue),
        participantsWithBalances,
      },
      participation: {
        companyParticipants: eligibleCompanyParticipants.length,
        individualParticipants: eligibleIndividualParticipants.length,
        totalParticipants: eligibleCompanyParticipants.length + eligibleIndividualParticipants.length,
        namedAttendees,
        totalSlots,
        unnamedSlots,
        volunteers: volunteersValue,
        personnelAssigned: personnelAssignedValue,
      },
      attentionItems: {
        upcomingEvents: withinThirtyDays,
        unassignedSlots: activeAttendeeSlots.filter((slot) => {
          const flight = normalizeValue(slot.flightAssignment);
          return !slot.actualName?.trim() || !["am", "pm"].includes(flight);
        }).length,
        companiesMissingContacts: companyMissingContacts.size,
        duplicateRecords: duplicateCompanyRecords + duplicateAttendeeRecords,
        unmatchedPayments,
      },
      nextEventReadiness: nextReadiness,
      eventPerformance,
      revenueTrend,
      packagePerformance,
      recentActivity,
      partialDataWarnings,
    };
  }
}
