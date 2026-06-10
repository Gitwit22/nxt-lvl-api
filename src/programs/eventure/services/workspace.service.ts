import { prisma } from "../../../core/db/prisma.js";
import { EventureServiceError } from "./eventure-error.js";
import { recordEventurePaymentTransaction } from "./payment-ledger.service.js";
import {
  assertEligiblePaymentStatus,
  isEligiblePaymentStatus,
} from "./participant-eligibility.service.js";

type CreateParticipantInput = {
  organizationId: string;
  eventId: string;
  createdByUserId?: string;
  companyName?: string;
  participantName?: string;
  email?: string;
  phone?: string;
  slotCount?: number;
};

type ConfirmPaymentInput = {
  organizationId: string;
  eventId: string;
  contactCompanyId: string;
  attendeeCount: number;
  amountDue?: number;
  amountPaid?: number;
  paymentMethod?: string | null;
  notes?: string | null;
  lineItems?: Array<{
    category: string;
    amount: number;
    description?: string | null;
  }>;
  actorUserId?: string;
  forceRemoveNamedSlots?: boolean;
};

type CreatePaymentTransactionInput = {
  organizationId: string;
  eventId: string;
  contactCompanyId: string;
  amountDue?: number;
  amountPaid: number;
  paymentMethod?: string | null;
  notes?: string | null;
  lineItems?: Array<{
    category: string;
    amount: number;
    description?: string | null;
  }>;
  actorUserId?: string;
};

function readLabelList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === "string").map((value) => value.trim().toLowerCase());
}

function resolveDefaultFlight(companyName: string, labels: unknown): "AM" | "PM" {
  const normalizedCompany = companyName.trim().toLowerCase();
  const hasDteLabel = readLabelList(labels).some((label) => label === "dte");
  return normalizedCompany === "dte" || hasDteLabel ? "AM" : "PM";
}

async function ensureEventAndCompany(input: { organizationId: string; eventId: string; contactCompanyId: string }) {
  const [event, sponsorOrganization] = await Promise.all([
    prisma.eventureEvent.findFirst({
      where: {
        id: input.eventId,
        organizationId: input.organizationId,
        archivedAt: null,
      },
    }),
    prisma.eventureSponsorOrganization.findFirst({
      where: {
        organizationId: input.organizationId,
        id: input.contactCompanyId,
      },
    }),
  ]);

  if (!event) {
    throw new EventureServiceError("Event not found.", 404);
  }

  if (!sponsorOrganization) {
    throw new EventureServiceError("Contact company not found.", 404);
  }

  return prisma.eventureEventSponsor.upsert({
    where: {
      organizationId_eventId_sponsorOrganizationId: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        sponsorOrganizationId: input.contactCompanyId,
      },
    },
    update: {
    },
    create: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      sponsorOrganizationId: input.contactCompanyId,
    },
    include: {
      sponsorOrganization: true,
    },
  });
}

async function ensureSponsorOrganizationActive(input: {
  organizationId: string;
  sponsorOrganizationId: string;
  sponsorStatus?: string | null;
}): Promise<void> {
  const normalized = (input.sponsorStatus ?? "").trim().toLowerCase();
  if (normalized === "active") {
    return;
  }

  await prisma.eventureSponsorOrganization.updateMany({
    where: {
      id: input.sponsorOrganizationId,
      organizationId: input.organizationId,
      archivedAt: null,
      OR: [{ sponsorStatus: null }, { sponsorStatus: { not: "active" } }],
    },
    data: {
      sponsorStatus: "active",
    },
  });
}

export async function reconcileAttendeeSlots(input: {
  organizationId: string;
  eventId: string;
  participantId: string;
  companyName: string;
  attendeeCount: number;
  flightAssignment: string;
  forceRemoveNamedSlots?: boolean;
}) {
  const existing = await prisma.eventureAttendeeSlot.findMany({
    where: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      participantId: input.participantId,
    },
    orderBy: [{ slotNumber: "asc" }],
  });

  if (input.attendeeCount < 0) {
    throw new EventureServiceError("attendeeCount must be zero or greater.", 400);
  }

  if (input.attendeeCount < existing.length) {
    const toRemove = existing.filter((slot) => slot.slotNumber > input.attendeeCount);
    const namedRemovals = toRemove.filter((slot) => !!slot.actualName?.trim());
    if (namedRemovals.length > 0 && !input.forceRemoveNamedSlots) {
      throw new EventureServiceError(
        `Reducing attendee count removes ${namedRemovals.length} named attendee slot(s). Resubmit with forceRemoveNamedSlots=true to confirm.`,
        409,
      );
    }

    if (toRemove.length > 0) {
      await prisma.eventureAttendeeSlot.deleteMany({
        where: {
          id: { in: toRemove.map((slot) => slot.id) },
          organizationId: input.organizationId,
        },
      });
    }
  }

  const survivors = await prisma.eventureAttendeeSlot.findMany({
    where: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      participantId: input.participantId,
    },
    orderBy: [{ slotNumber: "asc" }],
  });

  for (const slot of survivors) {
    await prisma.eventureAttendeeSlot.update({
      where: { id: slot.id },
      data: {
        companyName: input.companyName,
        displayName: `${input.companyName} Attendee ${slot.slotNumber}`,
        flightAssignment: input.flightAssignment,
      },
    });
  }

  if (input.attendeeCount > survivors.length) {
    const start = survivors.length + 1;
    const createPayload = Array.from({ length: input.attendeeCount - survivors.length }, (_, index) => {
      const slotNumber = start + index;
      return {
        organizationId: input.organizationId,
        eventId: input.eventId,
        participantId: input.participantId,
        companyName: input.companyName,
        slotNumber,
        displayName: `${input.companyName} Attendee ${slotNumber}`,
        flightAssignment: input.flightAssignment,
      };
    });

    await prisma.eventureAttendeeSlot.createMany({ data: createPayload });
  }
}

export async function assignRegistrationToSlot(input: {
  organizationId: string;
  eventId: string;
  registrationId: string;
  contactCompanyId: string;
  attendeeFullName?: string | null;
  actorUserId?: string;
}): Promise<void> {
  const participant = await prisma.eventureParticipant.findUnique({
    where: {
      organizationId_eventId_contactCompanyId: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        contactCompanyId: input.contactCompanyId,
      },
    },
  });

  // No participant yet for this company — nothing to link.
  if (!participant) return;

  await prisma.$transaction(async (tx) => {
    // Check if this registration already has a slot assigned.
    const alreadyLinked = await tx.eventureAttendeeSlot.findFirst({
      where: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        registrationId: input.registrationId,
      },
    });
    if (alreadyLinked) return;

    // Find the lowest open slot (no registrationId) for this participant.
    const openSlot = await tx.eventureAttendeeSlot.findFirst({
      where: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        participantId: participant.id,
        registrationId: null,
      },
      orderBy: [{ slotNumber: "asc" }],
    });

    if (openSlot) {
      // Link the registration to the open slot.
      await tx.eventureAttendeeSlot.update({
        where: { id: openSlot.id },
        data: {
          registrationId: input.registrationId,
          actualName: openSlot.actualName?.trim() ? openSlot.actualName : (input.attendeeFullName?.trim() || null),
        },
      });
    } else {
      // All slots occupied — create an overflow slot and increment attendeeCount.
      const maxSlot = await tx.eventureAttendeeSlot.findFirst({
        where: {
          organizationId: input.organizationId,
          eventId: input.eventId,
          participantId: participant.id,
        },
        orderBy: [{ slotNumber: "desc" }],
      });

      const nextSlotNumber = (maxSlot?.slotNumber ?? 0) + 1;
      const companyName = participant.companyName;

      await tx.eventureAttendeeSlot.create({
        data: {
          organizationId: input.organizationId,
          eventId: input.eventId,
          participantId: participant.id,
          companyName,
          registrationId: input.registrationId,
          slotNumber: nextSlotNumber,
          displayName: `${companyName} Attendee ${nextSlotNumber}`,
          actualName: input.attendeeFullName?.trim() || null,
          flightAssignment: participant.flightAssignment,
        },
      });

      await tx.eventureParticipant.update({
        where: { id: participant.id },
        data: { attendeeCount: { increment: 1 } },
      });
    }
  });
}

export async function listPaymentsForEvent(organizationId: string, eventId: string) {
  const sponsors = await prisma.eventureEventSponsor.findMany({
    where: {
      organizationId,
      eventId,
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
    orderBy: [{ sponsorOrganization: { name: "asc" } }],
  });

  const [payments, participants] = await Promise.all([
    prisma.eventurePayment.findMany({
      where: { organizationId, eventId },
      orderBy: [{ updatedAt: "desc" }],
    }),
    prisma.eventureParticipant.findMany({
      where: { organizationId, eventId },
      orderBy: [{ updatedAt: "desc" }],
    }),
  ]);

  const transactions = await prisma.eventurePaymentTransaction.findMany({
    where: { organizationId, eventId },
    include: {
      lineItems: {
        orderBy: [{ createdAt: "asc" }],
      },
    },
    orderBy: [{ transactionAt: "desc" }, { createdAt: "desc" }],
  });

  const participantSlotCounts = participants.length === 0
    ? []
    : await prisma.eventureAttendeeSlot.groupBy({
      by: ["participantId"],
      where: {
        organizationId,
        eventId,
        participantId: { in: participants.map((participant) => participant.id) },
      },
      _count: {
        _all: true,
      },
    });

  const companyIds = Array.from(new Set([
    ...sponsors.map((sponsor) => sponsor.sponsorOrganizationId),
    ...payments.map((payment) => payment.contactCompanyId),
    ...participants.map((participant) => participant.contactCompanyId),
    ...transactions.map((transaction) => transaction.contactCompanyId),
  ]));

  const organizations = companyIds.length === 0
    ? []
    : await prisma.eventureSponsorOrganization.findMany({
      where: {
        organizationId,
        id: { in: companyIds },
      },
      include: {
        contacts: {
          where: { archivedAt: null },
          orderBy: [{ isPrimary: "desc" }, { updatedAt: "desc" }],
        },
      },
    });

  const paymentByCompany = new Map<string, (typeof payments)[number]>();
  for (const payment of payments) {
    if (!paymentByCompany.has(payment.contactCompanyId)) {
      paymentByCompany.set(payment.contactCompanyId, payment);
    }
  }

  const participantByCompany = new Map<string, (typeof participants)[number]>();
  for (const participant of participants) {
    if (!participantByCompany.has(participant.contactCompanyId)) {
      participantByCompany.set(participant.contactCompanyId, participant);
    }
  }

  const transactionsByCompany = new Map<string, (typeof transactions)>();
  for (const transaction of transactions) {
    const bucket = transactionsByCompany.get(transaction.contactCompanyId) ?? [];
    bucket.push(transaction);
    transactionsByCompany.set(transaction.contactCompanyId, bucket);
  }

  const sponsorByCompany = new Map<string, (typeof sponsors)[number]>();
  for (const sponsor of sponsors) {
    if (!sponsorByCompany.has(sponsor.sponsorOrganizationId)) {
      sponsorByCompany.set(sponsor.sponsorOrganizationId, sponsor);
    }
  }

  const organizationByCompany = new Map<string, (typeof organizations)[number]>();
  for (const organization of organizations) {
    organizationByCompany.set(organization.id, organization);
  }

  const slotCountByParticipant = new Map<string, number>();
  for (const item of participantSlotCounts) {
    slotCountByParticipant.set(item.participantId, item._count._all);
  }

  const rows = companyIds.map((companyId) => {
    const payment = paymentByCompany.get(companyId) ?? null;
    const participant = participantByCompany.get(companyId) ?? null;
    const paymentTransactions = transactionsByCompany.get(companyId) ?? [];
    const sponsor = sponsorByCompany.get(companyId) ?? null;
    const company = organizationByCompany.get(companyId) ?? null;
    const primaryContact =
      company?.contacts.find((contact) => contact.isPrimary)
      ?? company?.contacts[0]
      ?? null;
    const participantWithSyncedSlots = participant
      ? {
        ...participant,
        attendeeCount: slotCountByParticipant.get(participant.id) ?? participant.attendeeCount,
      }
      : null;

    // Exclude pure contact-only entries: companies with neither a payment record
    // nor a participant record have no payment activity for this event.
    if (payment === null && participant === null && paymentTransactions.length === 0) return null;

    return {
      contactCompanyId: companyId,
      companyName: company?.name ?? participant?.companyName ?? "Unknown Company",
      contactName: primaryContact?.name ?? null,
      email: primaryContact?.email ?? company?.mainEmail ?? null,
      phone: primaryContact?.phone ?? company?.mainPhone ?? null,
      labels: company?.labels ?? null,
      companyStatus: company?.sponsorStatus ?? null,
      sponsorStatus: company?.sponsorStatus ?? null,
      payment,
      paymentTransactions,
      participant: participantWithSyncedSlots,
      convertedToParticipant: Boolean(participantWithSyncedSlots?.paymentConfirmed),
    };
  }).filter((row): row is Exclude<typeof row, null> => row !== null);

  rows.sort((left, right) => left.companyName.localeCompare(right.companyName));
  return rows;
}

export async function listAttendeesForEvent(organizationId: string, eventId: string) {
  return prisma.eventureAttendeeSlot.findMany({
    where: {
      organizationId,
      eventId,
    },
    orderBy: [
      { companyName: "asc" },
      { slotNumber: "asc" },
    ],
  });
}

async function syncRegistrationsOnPaymentConfirm(input: {
  organizationId: string;
  eventId: string;
  contactCompanyId: string;
  participantId: string;
  actorUserId?: string;
}): Promise<void> {
  const now = new Date();

  // Step 1: Mark all unpaid registrations for this company as "paid".
  await prisma.eventureRegistration.updateMany({
    where: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      contactCompanyId: input.contactCompanyId,
      paymentStatus: { not: "paid" },
    },
    data: {
      paymentStatus: "paid",
      paymentRecordedAt: now,
      paymentRecordedByUserId: input.actorUserId ?? null,
    },
  });

  // Step 2: Pair all "paid" registrations (oldest first) with slots (lowest slotNumber first)
  // and write registrationId where the slot is still unlinked.
  const [paidRegistrations, allSlots] = await Promise.all([
    prisma.eventureRegistration.findMany({
      where: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        contactCompanyId: input.contactCompanyId,
        paymentStatus: "paid",
      },
      include: { attendee: true },
      orderBy: [{ createdAt: "asc" }],
    }),
    prisma.eventureAttendeeSlot.findMany({
      where: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        participantId: input.participantId,
      },
      orderBy: [{ slotNumber: "asc" }],
    }),
  ]);

  // Build a set of registrationIds already linked to a slot so we skip them.
  const alreadyLinked = new Set(
    allSlots.map((s) => s.registrationId).filter((id): id is string => id !== null),
  );

  const unlinkedRegistrations = paidRegistrations.filter((r) => !alreadyLinked.has(r.id));
  const openSlots = allSlots.filter((s) => s.registrationId === null);

  // Pair deterministically: first unlinked reg → first open slot, etc.
  const pairs = unlinkedRegistrations.map((reg, index) => ({ reg, slot: openSlots[index] ?? null }));

  for (const { reg, slot } of pairs) {
    if (slot) {
      await prisma.eventureAttendeeSlot.update({
        where: { id: slot.id },
        data: {
          registrationId: reg.id,
          actualName: slot.actualName?.trim() ? slot.actualName : (reg.attendee?.fullName?.trim() || null),
        },
      });
    }
    // Registrations without a corresponding slot are left unlinked;
    // they will be assigned when the attendeeCount is increased or on a future confirmPayment call.
  }
}

export async function confirmPaymentAndSyncParticipant(input: ConfirmPaymentInput) {
  if (!Number.isInteger(input.attendeeCount) || input.attendeeCount < 0) {
    throw new EventureServiceError("attendeeCount must be a non-negative integer.", 400);
  }

  const eventSponsor = await ensureEventAndCompany(input);
  await ensureSponsorOrganizationActive({
    organizationId: input.organizationId,
    sponsorOrganizationId: eventSponsor.sponsorOrganization.id,
    sponsorStatus: eventSponsor.sponsorOrganization.sponsorStatus,
  });
  const companyName = eventSponsor.sponsorOrganization.name;

  const result = await prisma.$transaction(async (tx) => {
    const latestPayment = await tx.eventurePayment.findFirst({
      where: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        contactCompanyId: input.contactCompanyId,
      },
      orderBy: [{ updatedAt: "desc" }],
    });

    const amountDue = input.amountDue ?? latestPayment?.amountDue ?? eventSponsor.committedAmount ?? 0;
    const amountPaid = input.amountPaid ?? latestPayment?.amountPaid ?? eventSponsor.amountPaid ?? amountDue;

    const existingParticipant = await tx.eventureParticipant.findUnique({
      where: {
        organizationId_eventId_contactCompanyId: {
          organizationId: input.organizationId,
          eventId: input.eventId,
          contactCompanyId: input.contactCompanyId,
        },
      },
    });

    const defaultFlight = resolveDefaultFlight(companyName, eventSponsor.sponsorOrganization.labels);
    const chosenFlight = existingParticipant?.flightAssignment || defaultFlight;

    const participant = existingParticipant
      ? await tx.eventureParticipant.update({
        where: { id: existingParticipant.id },
        data: {
          companyName,
          paymentConfirmed: true,
          attendeeCount: input.attendeeCount,
          status: "active",
          flightAssignment: chosenFlight,
        },
      })
      : await tx.eventureParticipant.create({
        data: {
          organizationId: input.organizationId,
          eventId: input.eventId,
          contactCompanyId: input.contactCompanyId,
          companyName,
          paymentConfirmed: true,
          attendeeCount: input.attendeeCount,
          flightAssignment: chosenFlight,
          status: "active",
        },
      });

    const { payment } = await recordEventurePaymentTransaction({
      db: tx,
      organizationId: input.organizationId,
      eventId: input.eventId,
      contactCompanyId: input.contactCompanyId,
      participantId: participant.id,
      amountDue,
      amountPaid,
      paymentMethod: input.paymentMethod,
      notes: input.notes,
      changedByUserId: input.actorUserId,
      transactionType: "manual_confirm",
      source: "workspace_confirm",
      lineItems: input.lineItems?.length
        ? input.lineItems
        : [
          {
            category: "PARTICIPANT_PACKAGE",
            amount: amountPaid,
            description: input.notes ?? "Manual payment confirmation",
          },
        ],
    });

    await tx.eventurePayment.update({
      where: { id: payment.id },
      data: {
        participantId: participant.id,
      },
    });

    return { payment, participant };
  });

  await reconcileAttendeeSlots({
    organizationId: input.organizationId,
    eventId: input.eventId,
    participantId: result.participant.id,
    companyName: result.participant.companyName,
    attendeeCount: input.attendeeCount,
    flightAssignment: result.participant.flightAssignment,
    forceRemoveNamedSlots: input.forceRemoveNamedSlots,
  });

  // Reverse sync: mark all unlinked registrations for this company as "paid"
  // and pair them deterministically with slots by createdAt / slotNumber order.
  await syncRegistrationsOnPaymentConfirm({
    organizationId: input.organizationId,
    eventId: input.eventId,
    contactCompanyId: input.contactCompanyId,
    participantId: result.participant.id,
    actorUserId: input.actorUserId,
  });

  const [participant, slots] = await Promise.all([
    prisma.eventureParticipant.findUnique({ where: { id: result.participant.id } }),
    prisma.eventureAttendeeSlot.findMany({
      where: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        participantId: result.participant.id,
      },
      orderBy: [{ slotNumber: "asc" }],
    }),
  ]);

  return {
    payment: result.payment,
    participant,
    attendeeSlots: slots,
  };
}

export async function createParticipantForEvent(input: CreateParticipantInput) {
  const companyName = input.companyName?.trim();
  const participantName = input.participantName?.trim();

  if (!companyName && !participantName) {
    throw new EventureServiceError("Either companyName or participantName is required.", 400);
  }

  const displayName = companyName || participantName!;
  const isIndividual = !companyName && !!participantName;

  const event = await prisma.eventureEvent.findFirst({
    where: { id: input.eventId, organizationId: input.organizationId },
  });
  if (!event) {
    throw new EventureServiceError("Event not found.", 404);
  }

  const normalizedName = displayName.trim().toLowerCase();

  const company = await prisma.eventureSponsorOrganization.findFirst({
    where: { organizationId: input.organizationId, normalizedName },
  });

  if (!company) {
    throw new EventureServiceError("Company must already exist and be linked to the event before creating a participant.", 400);
  }

  const eventSponsor = await prisma.eventureEventSponsor.upsert({
    where: {
      organizationId_eventId_sponsorOrganizationId: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        sponsorOrganizationId: company.id,
      },
    },
    update: {
    },
    create: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      sponsorOrganizationId: company.id,
    },
    include: { sponsorOrganization: true },
  });
  await ensureSponsorOrganizationActive({
    organizationId: input.organizationId,
    sponsorOrganizationId: eventSponsor.sponsorOrganization.id,
    sponsorStatus: eventSponsor.sponsorOrganization.sponsorStatus,
  });

  const latestPayment = await prisma.eventurePayment.findFirst({
    where: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      contactCompanyId: company.id,
    },
    orderBy: [{ updatedAt: "desc" }],
  });

  assertEligiblePaymentStatus(latestPayment?.paymentStatus);

  const contactName = isIndividual ? participantName! : participantName;
  if (contactName && (input.email || input.phone)) {
    const existingContact = await prisma.eventureSponsorContact.findFirst({
      where: { organizationId: input.organizationId, sponsorOrganizationId: company.id, name: contactName },
    });
    if (!existingContact) {
      await prisma.eventureSponsorContact.create({
        data: {
          organizationId: input.organizationId,
          sponsorOrganizationId: company.id,
          name: contactName,
          email: input.email || null,
          phone: input.phone || null,
          isPrimary: true,
        },
      });
    }
  }

  const existingParticipant = await prisma.eventureParticipant.findFirst({
    where: { organizationId: input.organizationId, eventId: input.eventId, contactCompanyId: company.id },
  });
  if (existingParticipant) {
    throw new EventureServiceError("A participant for this company or person already exists for this event.", 409);
  }

  const slotCount = Number.isInteger(input.slotCount) && (input.slotCount ?? 0) > 0 ? input.slotCount! : 0;

  const participant = await prisma.eventureParticipant.create({
    data: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      contactCompanyId: company.id,
      companyName: displayName,
      paymentId: latestPayment!.id,
      paymentConfirmed: true,
      attendeeCount: slotCount,
      status: "active",
      flightAssignment: resolveDefaultFlight(displayName, eventSponsor.sponsorOrganization.labels),
    },
  });

  if (slotCount > 0) {
    await prisma.eventureAttendeeSlot.createMany({
      data: Array.from({ length: slotCount }, (_, i) => ({
        organizationId: input.organizationId,
        eventId: input.eventId,
        participantId: participant.id,
        companyName: displayName,
        slotNumber: i + 1,
        displayName: `${displayName} - Slot ${i + 1}`,
        flightAssignment: "PM",
      })),
    });
  }

  return prisma.eventureParticipant.findUniqueOrThrow({
    where: { id: participant.id },
    include: {
      contactCompany: {
        include: {
          contacts: {
            where: { archivedAt: null },
            orderBy: [{ isPrimary: "desc" }, { updatedAt: "desc" }],
          },
        },
      },
      attendeeSlots: { orderBy: [{ slotNumber: "asc" }] },
      payment: true,
    },
  });
}

export async function listParticipantsForEvent(organizationId: string, eventId: string) {
  const participants = await prisma.eventureParticipant.findMany({
    where: {
      organizationId,
      eventId,
    },
    include: {
      contactCompany: {
        include: {
          contacts: {
            where: { archivedAt: null },
            orderBy: [{ isPrimary: "desc" }, { updatedAt: "desc" }],
          },
        },
      },
      attendeeSlots: {
        orderBy: [{ slotNumber: "asc" }],
      },
      payment: true,
    },
    orderBy: [{ companyName: "asc" }],
  });

  if (participants.length === 0) {
    return participants;
  }

  const slotCounts = await prisma.eventureAttendeeSlot.groupBy({
    by: ["participantId"],
    where: {
      organizationId,
      eventId,
      participantId: { in: participants.map((participant) => participant.id) },
    },
    _count: {
      _all: true,
    },
  });

  const slotCountByParticipant = new Map<string, number>();
  for (const item of slotCounts) {
    slotCountByParticipant.set(item.participantId, item._count._all);
  }

  return participants.map((participant) => ({
    ...participant,
    attendeeCount: slotCountByParticipant.get(participant.id) ?? participant.attendeeCount,
  }));
}

export async function createStandalonePaymentTransaction(input: CreatePaymentTransactionInput) {
  if (!Number.isFinite(input.amountPaid) || input.amountPaid < 0) {
    throw new EventureServiceError("amountPaid must be 0 or greater.", 400);
  }

  const eventSponsor = await ensureEventAndCompany(input);
  await ensureSponsorOrganizationActive({
    organizationId: input.organizationId,
    sponsorOrganizationId: eventSponsor.sponsorOrganization.id,
    sponsorStatus: eventSponsor.sponsorOrganization.sponsorStatus,
  });

  const participant = await prisma.eventureParticipant.findUnique({
    where: {
      organizationId_eventId_contactCompanyId: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        contactCompanyId: input.contactCompanyId,
      },
    },
  });

  const amountDue = input.amountDue ?? eventSponsor.committedAmount ?? input.amountPaid;

  const { payment, transaction } = await prisma.$transaction(async (tx) => {
    const result = await recordEventurePaymentTransaction({
      db: tx,
      organizationId: input.organizationId,
      eventId: input.eventId,
      contactCompanyId: input.contactCompanyId,
      participantId: participant?.id,
      amountDue,
      amountPaid: input.amountPaid,
      paymentMethod: input.paymentMethod,
      notes: input.notes,
      changedByUserId: input.actorUserId,
      transactionType: "manual_transaction",
      source: "workspace_transaction",
      lineItems: input.lineItems,
    });

    if (participant) {
      await tx.eventureParticipant.update({
        where: { id: participant.id },
        data: {
          paymentId: result.payment.id,
          paymentConfirmed: isEligiblePaymentStatus(result.payment.paymentStatus),
        },
      });
    }

    return result;
  });

  return {
    payment,
    transaction,
    participant,
  };
}

export async function updateParticipantFlightAssignment(input: {
  organizationId: string;
  eventId: string;
  participantId: string;
  flightAssignment: string;
}) {
  const participant = await prisma.eventureParticipant.findFirst({
    where: {
      id: input.participantId,
      organizationId: input.organizationId,
      eventId: input.eventId,
    },
  });

  if (!participant) {
    throw new EventureServiceError("Participant not found.", 404);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.eventureParticipant.update({
      where: { id: input.participantId },
      data: { flightAssignment: input.flightAssignment },
    });

    await tx.eventureAttendeeSlot.updateMany({
      where: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        participantId: input.participantId,
      },
      data: {
        flightAssignment: input.flightAssignment,
      },
    });

    return next;
  });

  return updated;
}

export async function updateAttendeeSlot(input: {
  organizationId: string;
  eventId: string;
  slotId: string;
  actualName?: string | null;
  notes?: string | null;
  checkedIn?: boolean;
}) {
  const slot = await prisma.eventureAttendeeSlot.findFirst({
    where: {
      id: input.slotId,
      organizationId: input.organizationId,
      eventId: input.eventId,
    },
  });

  if (!slot) {
    throw new EventureServiceError("Attendee slot not found.", 404);
  }

  return prisma.eventureAttendeeSlot.update({
    where: { id: input.slotId },
    data: {
      actualName: input.actualName === undefined ? slot.actualName : input.actualName,
      notes: input.notes === undefined ? slot.notes : input.notes,
      checkedIn: input.checkedIn === undefined ? slot.checkedIn : input.checkedIn,
    },
  });
}

export async function updateParticipantAttendeeCount(input: {
  organizationId: string;
  eventId: string;
  participantId: string;
  attendeeCount: number;
  forceRemoveNamedSlots?: boolean;
}) {
  const participant = await prisma.eventureParticipant.findFirst({
    where: {
      id: input.participantId,
      organizationId: input.organizationId,
      eventId: input.eventId,
    },
  });

  if (!participant) {
    throw new EventureServiceError("Participant not found.", 404);
  }

  await prisma.eventureParticipant.update({
    where: { id: input.participantId },
    data: {
      attendeeCount: input.attendeeCount,
    },
  });

  await reconcileAttendeeSlots({
    organizationId: input.organizationId,
    eventId: input.eventId,
    participantId: input.participantId,
    companyName: participant.companyName,
    attendeeCount: input.attendeeCount,
    flightAssignment: participant.flightAssignment,
    forceRemoveNamedSlots: input.forceRemoveNamedSlots,
  });

  return prisma.eventureParticipant.findUnique({
    where: { id: input.participantId },
    include: {
      attendeeSlots: {
        orderBy: [{ slotNumber: "asc" }],
      },
      payment: true,
    },
  });
}

export async function removeParticipantFromEvent(input: {
  organizationId: string;
  eventId: string;
  participantId: string;
}) {
  const participant = await prisma.eventureParticipant.findFirst({
    where: {
      id: input.participantId,
      organizationId: input.organizationId,
      eventId: input.eventId,
    },
    select: {
      id: true,
      contactCompanyId: true,
    },
  });

  if (!participant) {
    throw new EventureServiceError("Participant not found.", 404);
  }

  await prisma.$transaction(async (tx) => {
    await tx.eventurePayment.updateMany({
      where: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        participantId: participant.id,
      },
      data: {
        participantId: null,
      },
    });

    await tx.eventurePaymentTransaction.updateMany({
      where: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        participantId: participant.id,
      },
      data: {
        participantId: null,
      },
    });

    await tx.eventurePaymentLineItem.updateMany({
      where: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        participantId: participant.id,
      },
      data: {
        participantId: null,
      },
    });

    await tx.eventureUnmatchedRevenue.updateMany({
      where: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        matchedParticipantId: participant.id,
      },
      data: {
        matchedParticipantId: null,
      },
    });

    await tx.eventureParticipant.delete({
      where: { id: participant.id },
    });
  });

  return {
    removedParticipantId: participant.id,
    contactCompanyId: participant.contactCompanyId,
  };
}

export async function mergeParticipantIntoCompany(input: {
  organizationId: string;
  eventId: string;
  sourceParticipantId: string;
  targetCompanyId: string;
}) {
  const sourceParticipant = await prisma.eventureParticipant.findFirst({
    where: {
      id: input.sourceParticipantId,
      organizationId: input.organizationId,
      eventId: input.eventId,
    },
    select: {
      id: true,
      contactCompanyId: true,
      companyName: true,
      paymentConfirmed: true,
      flightAssignment: true,
    },
  });

  if (!sourceParticipant) {
    throw new EventureServiceError("Source participant not found.", 404);
  }

  if (sourceParticipant.contactCompanyId === input.targetCompanyId) {
    throw new EventureServiceError("Target company must be different from source company.", 400);
  }

  const targetSponsor = await ensureEventAndCompany({
    organizationId: input.organizationId,
    eventId: input.eventId,
    contactCompanyId: input.targetCompanyId,
  });

  const merged = await prisma.$transaction(async (tx) => {
    const existingTarget = await tx.eventureParticipant.findUnique({
      where: {
        organizationId_eventId_contactCompanyId: {
          organizationId: input.organizationId,
          eventId: input.eventId,
          contactCompanyId: input.targetCompanyId,
        },
      },
      select: {
        id: true,
        companyName: true,
        paymentConfirmed: true,
        flightAssignment: true,
      },
    });

    const targetParticipant = existingTarget
      ? await tx.eventureParticipant.update({
        where: { id: existingTarget.id },
        data: {
          companyName: targetSponsor.sponsorOrganization.name,
        },
        select: {
          id: true,
          companyName: true,
          paymentConfirmed: true,
          flightAssignment: true,
        },
      })
      : await tx.eventureParticipant.create({
        data: {
          organizationId: input.organizationId,
          eventId: input.eventId,
          contactCompanyId: input.targetCompanyId,
          companyName: targetSponsor.sponsorOrganization.name,
          paymentConfirmed: sourceParticipant.paymentConfirmed,
          attendeeCount: 0,
          flightAssignment: sourceParticipant.flightAssignment,
          status: "active",
        },
        select: {
          id: true,
          companyName: true,
          paymentConfirmed: true,
          flightAssignment: true,
        },
      });

    const [targetSlots, sourceSlots] = await Promise.all([
      tx.eventureAttendeeSlot.findMany({
        where: {
          organizationId: input.organizationId,
          eventId: input.eventId,
          participantId: targetParticipant.id,
        },
        orderBy: [{ slotNumber: "asc" }],
      }),
      tx.eventureAttendeeSlot.findMany({
        where: {
          organizationId: input.organizationId,
          eventId: input.eventId,
          participantId: sourceParticipant.id,
        },
        orderBy: [{ slotNumber: "asc" }],
      }),
    ]);

    let nextSlotNumber = (targetSlots[targetSlots.length - 1]?.slotNumber ?? 0) + 1;
    for (const slot of sourceSlots) {
      await tx.eventureAttendeeSlot.update({
        where: { id: slot.id },
        data: {
          participantId: targetParticipant.id,
          companyName: targetSponsor.sponsorOrganization.name,
          slotNumber: nextSlotNumber,
          displayName: `${targetSponsor.sponsorOrganization.name} Attendee ${nextSlotNumber}`,
          flightAssignment: targetParticipant.flightAssignment,
        },
      });
      nextSlotNumber += 1;
    }

    await tx.eventureAssignment.updateMany({
      where: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        participantId: sourceParticipant.id,
      },
      data: {
        participantId: targetParticipant.id,
      },
    });

    await tx.eventurePayment.updateMany({
      where: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        contactCompanyId: sourceParticipant.contactCompanyId,
      },
      data: {
        contactCompanyId: input.targetCompanyId,
        participantId: targetParticipant.id,
      },
    });

    await tx.eventurePaymentTransaction.updateMany({
      where: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        contactCompanyId: sourceParticipant.contactCompanyId,
      },
      data: {
        contactCompanyId: input.targetCompanyId,
        participantId: targetParticipant.id,
      },
    });

    await tx.eventurePaymentLineItem.updateMany({
      where: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        contactCompanyId: sourceParticipant.contactCompanyId,
      },
      data: {
        contactCompanyId: input.targetCompanyId,
        participantId: targetParticipant.id,
      },
    });

    await tx.eventureUnmatchedRevenue.updateMany({
      where: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        matchedParticipantId: sourceParticipant.id,
      },
      data: {
        matchedParticipantId: targetParticipant.id,
      },
    });

    const latestTargetPayment = await tx.eventurePayment.findFirst({
      where: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        contactCompanyId: input.targetCompanyId,
      },
      orderBy: [{ updatedAt: "desc" }],
      select: {
        id: true,
        paymentStatus: true,
      },
    });

    const targetSlotCount = await tx.eventureAttendeeSlot.count({
      where: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        participantId: targetParticipant.id,
      },
    });

    await tx.eventureParticipant.update({
      where: { id: targetParticipant.id },
      data: {
        attendeeCount: targetSlotCount,
        paymentId: latestTargetPayment?.id ?? null,
        paymentConfirmed: latestTargetPayment?.paymentStatus === "confirmed" || sourceParticipant.paymentConfirmed || targetParticipant.paymentConfirmed,
        companyName: targetSponsor.sponsorOrganization.name,
      },
    });

    await tx.eventureParticipant.delete({ where: { id: sourceParticipant.id } });

    return tx.eventureParticipant.findUnique({
      where: { id: targetParticipant.id },
      include: {
        attendeeSlots: {
          orderBy: [{ slotNumber: "asc" }],
        },
        payment: true,
      },
    });
  });

  return {
    mergedParticipant: merged,
    sourceParticipantId: sourceParticipant.id,
    targetCompanyId: input.targetCompanyId,
  };
}

export async function listVolunteersForEvent(organizationId: string, eventId: string) {
  return prisma.eventureEventVolunteerNeed.findMany({
    where: {
      organizationId,
      eventId,
      archivedAt: null,
    },
    orderBy: [{ roleName: "asc" }],
  });
}

export async function listAssignmentsForEvent(organizationId: string, eventId: string) {
  return prisma.eventureAssignment.findMany({
    where: {
      organizationId,
      eventId,
    },
    include: {
      participant: true,
      attendeeSlot: true,
      volunteerNeed: true,
    },
    orderBy: [{ createdAt: "desc" }],
  });
}

export type CleanupUnconfirmedParticipantsResult = {
  dryRun: boolean;
  repaired: number;
  archived: number;
  participants: Array<{
    id: string;
    companyName: string;
    action: "repaired" | "archived";
    paymentId?: string;
  }>;
};

export async function cleanupUnconfirmedParticipants(input: {
  organizationId: string;
  eventId: string;
  dryRun?: boolean;
}): Promise<CleanupUnconfirmedParticipantsResult> {
  const unconfirmed = await prisma.eventureParticipant.findMany({
    where: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      paymentConfirmed: false,
      status: { not: "archived" },
    },
    select: {
      id: true,
      companyName: true,
      contactCompanyId: true,
      attendeeCount: true,
      flightAssignment: true,
    },
  });

  const result: CleanupUnconfirmedParticipantsResult = {
    dryRun: input.dryRun ?? false,
    repaired: 0,
    archived: 0,
    participants: [],
  };

  for (const participant of unconfirmed) {
    const confirmedPayment = await prisma.eventurePayment.findFirst({
      where: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        contactCompanyId: participant.contactCompanyId,
        paymentStatus: "confirmed",
      },
      orderBy: [{ updatedAt: "desc" }],
    });

    if (confirmedPayment) {
      // Repair: link payment and confirm participant
      if (!input.dryRun) {
        await prisma.eventureParticipant.update({
          where: { id: participant.id },
          data: {
            paymentConfirmed: true,
            paymentId: confirmedPayment.id,
          },
        });

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

      result.repaired += 1;
      result.participants.push({
        id: participant.id,
        companyName: participant.companyName,
        action: "repaired",
        paymentId: confirmedPayment.id,
      });
    } else {
      // No confirmed payment — soft-archive the participant
      if (!input.dryRun) {
        await prisma.eventureParticipant.update({
          where: { id: participant.id },
          data: { status: "archived" },
        });
      }

      result.archived += 1;
      result.participants.push({
        id: participant.id,
        companyName: participant.companyName,
        action: "archived",
      });
    }
  }

  return result;
}

export async function createAssignmentForEvent(input: {
  organizationId: string;
  eventId: string;
  assignmentType?: string;
  targetType: "participant" | "attendee_slot" | "volunteer" | "staff";
  participantId?: string;
  attendeeSlotId?: string;
  volunteerNeedId?: string;
  staffMemberName?: string;
  title: string;
  notes?: string | null;
  actorUserId?: string;
}) {
  if (!input.title.trim()) {
    throw new EventureServiceError("title is required.", 400);
  }

  if (!input.targetType) {
    throw new EventureServiceError("targetType is required.", 400);
  }

  if (input.targetType === "participant" && !input.participantId) {
    throw new EventureServiceError("participantId is required when targetType is participant.", 400);
  }

  if (input.targetType === "attendee_slot" && !input.attendeeSlotId) {
    throw new EventureServiceError("attendeeSlotId is required when targetType is attendee_slot.", 400);
  }

  if (input.targetType === "volunteer" && !input.volunteerNeedId) {
    throw new EventureServiceError("volunteerNeedId is required when targetType is volunteer.", 400);
  }

  if (input.targetType === "staff" && !input.staffMemberName?.trim()) {
    throw new EventureServiceError("staffMemberName is required when targetType is staff.", 400);
  }

  return prisma.eventureAssignment.create({
    data: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      assignmentType: input.assignmentType ?? "general",
      targetType: input.targetType,
      participantId: input.participantId,
      attendeeSlotId: input.attendeeSlotId,
      volunteerNeedId: input.volunteerNeedId,
      staffMemberName: input.staffMemberName?.trim() || null,
      title: input.title.trim(),
      notes: input.notes ?? null,
      createdByUserId: input.actorUserId ?? null,
    },
    include: {
      participant: true,
      attendeeSlot: true,
      volunteerNeed: true,
    },
  });
}
