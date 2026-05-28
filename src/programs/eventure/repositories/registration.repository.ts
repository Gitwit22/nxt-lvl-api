import { Prisma } from "@prisma/client";
import { prisma } from "../../../core/db/prisma.js";

export type CreateEventureRegistrationInput = {
  organizationId: string;
  eventId: string;
  createdByUserId: string;
  firstName?: string;
  lastName?: string;
  fullName: string;
  email?: string;
  phone?: string;
  company?: string;
  title?: string;
  tags?: unknown;
  attendeeSource?: string;
  attendeeNotes?: string;
  registrationType?: string;
  registrationStatus?: string;
  paymentStatus?: string;
  ticketTypeId?: string;
  groupId?: string;
  householdId?: string;
  amountExpected?: number;
  amountPaid?: number;
  paymentMethod?: string;
  paymentReference?: string;
  paymentNotes?: string;
  source?: string;
  importBatchId?: string;
  notes?: string;
};

export type UpdateEventureRegistrationInput = {
  registrationType?: string;
  registrationStatus?: string;
  paymentStatus?: string;
  ticketTypeId?: string | null;
  groupId?: string | null;
  householdId?: string | null;
  amountExpected?: number;
  amountPaid?: number;
  paymentMethod?: string | null;
  paymentReference?: string | null;
  paymentNotes?: string | null;
  paymentRecordedAt?: Date | null;
  paymentRecordedByUserId?: string | null;
  checkedIn?: boolean;
  checkedInAt?: Date | null;
  checkedInByUserId?: string | null;
  source?: string;
  importBatchId?: string | null;
  notes?: string | null;
};

export async function getEventForOrganization(organizationId: string, eventId: string) {
  return prisma.eventureEvent.findFirst({
    where: {
      id: eventId,
      organizationId,
      archivedAt: null,
    },
  });
}

async function findOrCreateAttendee(input: CreateEventureRegistrationInput) {
  const email = input.email?.trim().toLowerCase();
  const phone = input.phone?.trim();
  const fullName = input.fullName.trim();

  let attendee = null;
  if (email) {
    attendee = await prisma.eventureAttendee.findFirst({
      where: {
        organizationId: input.organizationId,
        email: {
          equals: email,
          mode: "insensitive",
        },
      },
    });
  }

  if (!attendee && phone) {
    attendee = await prisma.eventureAttendee.findFirst({
      where: {
        organizationId: input.organizationId,
        phone,
      },
    });
  }

  if (!attendee) {
    attendee = await prisma.eventureAttendee.create({
      data: {
        organizationId: input.organizationId,
        firstName: input.firstName,
        lastName: input.lastName,
        fullName,
        email,
        phone,
        company: input.company,
        title: input.title,
        tags: (input.tags ?? []) as Prisma.InputJsonValue,
        source: input.attendeeSource ?? "manual",
        notes: input.attendeeNotes,
        createdByUserId: input.createdByUserId,
      },
    });
  }

  return attendee;
}

export async function listRegistrationsForEvent(organizationId: string, eventId: string) {
  return prisma.eventureRegistration.findMany({
    where: {
      organizationId,
      eventId,
    },
    include: {
      attendee: true,
      ticketType: true,
    },
    orderBy: [{ createdAt: "desc" }],
  });
}

export async function createRegistrationForEvent(input: CreateEventureRegistrationInput) {
  const attendee = await findOrCreateAttendee(input);

  const created = await prisma.eventureRegistration.create({
    data: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      attendeeId: attendee.id,
      registrationType: input.registrationType ?? "registered",
      registrationStatus: input.registrationStatus ?? "registered",
      paymentStatus: input.paymentStatus ?? "unpaid",
      ticketTypeId: input.ticketTypeId,
      groupId: input.groupId,
      householdId: input.householdId,
      amountExpected: input.amountExpected ?? 0,
      amountPaid: input.amountPaid ?? 0,
      paymentMethod: input.paymentMethod,
      paymentReference: input.paymentReference,
      paymentNotes: input.paymentNotes,
      paymentRecordedAt: input.paymentStatus ? new Date() : null,
      paymentRecordedByUserId: input.paymentStatus ? input.createdByUserId : null,
      source: input.source ?? "manual",
      importBatchId: input.importBatchId,
      notes: input.notes,
      createdByUserId: input.createdByUserId,
    },
    include: {
      attendee: true,
      ticketType: true,
    },
  });

  await prisma.eventureRegistrationPaymentLog.create({
    data: {
      organizationId: input.organizationId,
      registrationId: created.id,
      paymentStatus: created.paymentStatus,
      amountExpected: created.amountExpected,
      amountPaid: created.amountPaid,
      paymentMethod: created.paymentMethod,
      paymentReference: created.paymentReference,
      paymentNotes: created.paymentNotes,
      recordedByUserId: input.createdByUserId,
    },
  });

  return created;
}

export async function getRegistrationById(organizationId: string, registrationId: string) {
  return prisma.eventureRegistration.findFirst({
    where: {
      id: registrationId,
      organizationId,
    },
    include: {
      attendee: true,
      ticketType: true,
      event: true,
    },
  });
}

export async function updateRegistrationById(
  organizationId: string,
  registrationId: string,
  data: UpdateEventureRegistrationInput,
) {
  return prisma.eventureRegistration.updateMany({
    where: {
      id: registrationId,
      organizationId,
    },
    data,
  });
}

export async function removeRegistrationById(organizationId: string, registrationId: string) {
  return prisma.eventureRegistration.deleteMany({
    where: {
      id: registrationId,
      organizationId,
    },
  });
}

export async function addPaymentLog(input: {
  organizationId: string;
  registrationId: string;
  paymentStatus: string;
  amountExpected: number;
  amountPaid: number;
  paymentMethod?: string | null;
  paymentReference?: string | null;
  paymentNotes?: string | null;
  recordedByUserId?: string | null;
}) {
  return prisma.eventureRegistrationPaymentLog.create({
    data: {
      organizationId: input.organizationId,
      registrationId: input.registrationId,
      paymentStatus: input.paymentStatus,
      amountExpected: input.amountExpected,
      amountPaid: input.amountPaid,
      paymentMethod: input.paymentMethod,
      paymentReference: input.paymentReference,
      paymentNotes: input.paymentNotes,
      recordedByUserId: input.recordedByUserId,
    },
  });
}

export async function addCheckInLog(input: {
  organizationId: string;
  eventId: string;
  registrationId: string;
  attendeeId: string;
  checkInType?: string;
  checkedInByUserId?: string;
  deviceLabel?: string;
  notes?: string;
}) {
  return prisma.eventureCheckInLog.create({
    data: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      registrationId: input.registrationId,
      attendeeId: input.attendeeId,
      checkInType: input.checkInType ?? "manual",
      checkedInByUserId: input.checkedInByUserId,
      deviceLabel: input.deviceLabel,
      notes: input.notes,
    },
  });
}

export async function listCheckInsForEvent(organizationId: string, eventId: string) {
  return prisma.eventureCheckInLog.findMany({
    where: {
      organizationId,
      eventId,
    },
    include: {
      attendee: true,
      registration: {
        include: {
          ticketType: true,
        },
      },
    },
    orderBy: [{ checkedInAt: "desc" }],
  });
}

export function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}