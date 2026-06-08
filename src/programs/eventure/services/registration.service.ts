import {
  addCheckInLog,
  addPaymentLog,
  createRegistrationForEvent,
  getEventForOrganization,
  getRegistrationById,
  isUniqueConstraintError,
  listCheckInsForEvent,
  listRegistrationsForEvent,
  removeRegistrationById,
  updateRegistrationById,
  type CreateEventureRegistrationInput,
} from "../repositories/registration.repository.js";
import { prisma } from "../../../core/db/prisma.js";
import { assignRegistrationToSlot } from "./workspace.service.js";
import { EventureServiceError } from "./eventure-error.js";

export async function listAttendeesForEvent(organizationId: string, eventId: string) {
  const event = await getEventForOrganization(organizationId, eventId);
  if (!event) {
    throw new EventureServiceError("Event not found.", 404);
  }

  const registrations = await listRegistrationsForEvent(organizationId, eventId);

  const companyIds = Array.from(
    new Set(
      registrations
        .map((registration) => registration.contactCompanyId)
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0),
    ),
  );

  if (companyIds.length === 0) {
    return registrations;
  }

  const payments = await prisma.eventurePayment.findMany({
    where: {
      organizationId,
      eventId,
      contactCompanyId: { in: companyIds },
    },
    orderBy: [{ updatedAt: "desc" }],
  });

  const latestPaymentByCompany = new Map<string, (typeof payments)[number]>();
  for (const payment of payments) {
    if (!latestPaymentByCompany.has(payment.contactCompanyId)) {
      latestPaymentByCompany.set(payment.contactCompanyId, payment);
    }
  }

  return registrations.map((registration) => {
    if (!registration.contactCompanyId) {
      return registration;
    }

    const latestPayment = latestPaymentByCompany.get(registration.contactCompanyId);
    if (!latestPayment?.paymentStatus) {
      return registration;
    }

    return {
      ...registration,
      paymentStatus: latestPayment.paymentStatus,
    };
  });
}

export async function createAttendeeRegistrationForEvent(input: CreateEventureRegistrationInput) {
  const event = await getEventForOrganization(input.organizationId, input.eventId);
  if (!event) {
    throw new EventureServiceError("Event not found.", 404);
  }

  if (!input.fullName.trim()) {
    throw new EventureServiceError("fullName is required.", 400);
  }

  try {
    return await createRegistrationForEvent(input);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new EventureServiceError("Attendee is already registered for this event.", 409);
    }
    throw error;
  }
}

export async function getRegistrationForOrganization(organizationId: string, registrationId: string) {
  const registration = await getRegistrationById(organizationId, registrationId);
  if (!registration) {
    throw new EventureServiceError("Registration not found.", 404);
  }
  return registration;
}

export async function patchRegistrationForOrganization(
  organizationId: string,
  registrationId: string,
  patch: Parameters<typeof updateRegistrationById>[2],
) {
  const current = await getRegistrationForOrganization(organizationId, registrationId);

  const updated = await updateRegistrationById(organizationId, registrationId, patch);
  if (updated.count === 0) {
    throw new EventureServiceError("Registration not found.", 404);
  }

  const next = await getRegistrationForOrganization(organizationId, registrationId);

  if (
    patch.paymentStatus !== undefined ||
    patch.amountExpected !== undefined ||
    patch.amountPaid !== undefined ||
    patch.paymentMethod !== undefined ||
    patch.paymentReference !== undefined ||
    patch.paymentNotes !== undefined
  ) {
    await addPaymentLog({
      organizationId,
      registrationId,
      paymentStatus: next.paymentStatus,
      amountExpected: next.amountExpected,
      amountPaid: next.amountPaid,
      paymentMethod: next.paymentMethod,
      paymentReference: next.paymentReference,
      paymentNotes: next.paymentNotes,
      recordedByUserId: patch.paymentRecordedByUserId ?? null,
    });
  }

  return next;
}

export async function deleteRegistrationForOrganization(organizationId: string, registrationId: string) {
  const current = await getRegistrationForOrganization(organizationId, registrationId);
  const result = await removeRegistrationById(organizationId, registrationId);
  if (result.count === 0) {
    throw new EventureServiceError("Registration not found.", 404);
  }
  return current;
}

export async function updatePaymentStatusForRegistration(input: {
  organizationId: string;
  registrationId: string;
  paymentStatus: string;
  contactCompanyId?: string | null;
  amountExpected?: number;
  amountPaid?: number;
  paymentMethod?: string | null;
  paymentReference?: string | null;
  paymentNotes?: string | null;
  actorUserId?: string;
}) {
  const current = await getRegistrationForOrganization(input.organizationId, input.registrationId);

  if (!input.paymentStatus.trim()) {
    throw new EventureServiceError("paymentStatus is required.", 400);
  }

  const contactCompanyId =
    input.contactCompanyId !== undefined ? input.contactCompanyId : current.contactCompanyId;

  const updated = await patchRegistrationForOrganization(input.organizationId, input.registrationId, {
    paymentStatus: input.paymentStatus,
    contactCompanyId,
    amountExpected: input.amountExpected ?? current.amountExpected,
    amountPaid: input.amountPaid ?? current.amountPaid,
    paymentMethod: input.paymentMethod ?? current.paymentMethod,
    paymentReference: input.paymentReference ?? current.paymentReference,
    paymentNotes: input.paymentNotes ?? current.paymentNotes,
    paymentRecordedAt: new Date(),
    paymentRecordedByUserId: input.actorUserId ?? null,
  });

  // Best-effort: attempt slot assignment when status becomes "paid" and company is known.
  if (input.paymentStatus === "paid" && contactCompanyId) {
    try {
      await assignRegistrationToSlot({
        organizationId: input.organizationId,
        eventId: current.eventId,
        registrationId: input.registrationId,
        contactCompanyId,
        attendeeFullName: current.attendee?.fullName,
        actorUserId: input.actorUserId,
      });
    } catch {
      // Non-fatal — slot assignment failure does not fail the status update.
    }
  }

  return updated;
}

export async function listCheckInsForOrganizationEvent(organizationId: string, eventId: string) {
  const event = await getEventForOrganization(organizationId, eventId);
  if (!event) {
    throw new EventureServiceError("Event not found.", 404);
  }
  return listCheckInsForEvent(organizationId, eventId);
}

export async function createCheckInForRegistration(input: {
  organizationId: string;
  eventId: string;
  registrationId: string;
  checkInType?: string;
  checkedInByUserId?: string;
  deviceLabel?: string;
  notes?: string;
}) {
  const registration = await getRegistrationForOrganization(input.organizationId, input.registrationId);

  if (registration.eventId !== input.eventId) {
    throw new EventureServiceError("Registration does not belong to this event.", 400);
  }

  await updateRegistrationById(input.organizationId, input.registrationId, {
    checkedIn: true,
    checkedInAt: new Date(),
    checkedInByUserId: input.checkedInByUserId ?? null,
    registrationStatus: registration.registrationStatus === "cancelled" ? registration.registrationStatus : "attended",
  });

  await addCheckInLog({
    organizationId: input.organizationId,
    eventId: input.eventId,
    registrationId: input.registrationId,
    attendeeId: registration.attendeeId,
    checkInType: input.checkInType,
    checkedInByUserId: input.checkedInByUserId,
    deviceLabel: input.deviceLabel,
    notes: input.notes,
  });

  return getRegistrationForOrganization(input.organizationId, input.registrationId);
}

export async function createWalkInRegistrationAndCheckIn(input: {
  organizationId: string;
  eventId: string;
  fullName: string;
  email?: string;
  phone?: string;
  company?: string;
  title?: string;
  registrationType?: string;
  actorUserId: string;
  notes?: string;
  paymentStatus?: string;
}) {
  const created = await createAttendeeRegistrationForEvent({
    organizationId: input.organizationId,
    eventId: input.eventId,
    createdByUserId: input.actorUserId,
    fullName: input.fullName,
    email: input.email,
    phone: input.phone,
    company: input.company,
    title: input.title,
    attendeeSource: "walk_in",
    source: "walk_in",
    registrationType: input.registrationType ?? "walk_in",
    registrationStatus: "registered",
    paymentStatus: input.paymentStatus ?? "pending",
    notes: input.notes,
  });

  return createCheckInForRegistration({
    organizationId: input.organizationId,
    eventId: input.eventId,
    registrationId: created.id,
    checkInType: "walk_in",
    checkedInByUserId: input.actorUserId,
    notes: input.notes,
  });
}