import { prisma } from "../../../core/db/prisma.js";
import { EventureServiceError } from "./eventure-error.js";
import {
  createOrUpdateAttendee,
  type AttendeeIdentityInput,
  type CreateOrUpdateResult,
} from "./attendee-identity.service.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BulkFillRow = {
  rowId: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  companyId?: string | null;
  companyName?: string | null;
  title?: string | null;
};

export type BulkFillRowResult = {
  rowId: string;
  attendeeId?: string;
  slotId?: string;
  status: "assigned" | "no_open_slot" | "identity_error";
  warning?: string;
  action?: CreateOrUpdateResult["action"];
};

// ---------------------------------------------------------------------------
// Assign an existing attendee to a slot
// ---------------------------------------------------------------------------

export async function assignAttendeeToSlot(input: {
  slotId: string;
  attendeeId: string;
  eventId: string;
  organizationId: string;
  userId?: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const slot = await tx.eventureAttendeeSlot.findFirst({
      where: { id: input.slotId, organizationId: input.organizationId, eventId: input.eventId },
    });
    if (!slot) {
      throw new EventureServiceError("Slot not found or does not belong to this event.", 404);
    }

    const attendee = await tx.eventureAttendee.findFirst({
      where: { id: input.attendeeId, organizationId: input.organizationId, archivedAt: null },
    });
    if (!attendee) {
      throw new EventureServiceError("Attendee not found or does not belong to this organization.", 404);
    }

    if (slot.attendeeId === input.attendeeId) {
      throw new EventureServiceError("Attendee is already assigned to this slot.", 409);
    }

    await tx.eventureAttendeeSlot.update({
      where: { id: input.slotId },
      data: { attendeeId: input.attendeeId },
    });
  });
}

// ---------------------------------------------------------------------------
// Unassign attendee from slot (preserve name fields)
// ---------------------------------------------------------------------------

export async function unassignAttendeeFromSlot(input: {
  slotId: string;
  eventId: string;
  organizationId: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const slot = await tx.eventureAttendeeSlot.findFirst({
      where: { id: input.slotId, organizationId: input.organizationId, eventId: input.eventId },
    });
    if (!slot) {
      throw new EventureServiceError("Slot not found or does not belong to this event.", 404);
    }
    if (!slot.attendeeId) {
      return; // Already unassigned — no-op
    }

    await tx.eventureAttendeeSlot.update({
      where: { id: input.slotId },
      // Clear attendeeId only — actualName and displayName are preserved
      data: { attendeeId: null },
    });
  });
}

// ---------------------------------------------------------------------------
// Bulk fill slots for a participant (atomic by default)
// ---------------------------------------------------------------------------

export async function bulkFillSlots(input: {
  participantId: string;
  rows: BulkFillRow[];
  eventId: string;
  organizationId: string;
  userId?: string;
  allowPartial?: boolean;
}): Promise<BulkFillRowResult[]> {
  const results: BulkFillRowResult[] = [];

  const executeAssignments = async (): Promise<void> => {
    await prisma.$transaction(async (tx) => {
      // Fetch open slots for participant in order
      const openSlots = await tx.eventureAttendeeSlot.findMany({
        where: {
          organizationId: input.organizationId,
          eventId: input.eventId,
          participantId: input.participantId,
          attendeeId: null,
        },
        orderBy: { slotNumber: "asc" },
      });

      let slotIndex = 0;

      for (const row of input.rows) {
        if (slotIndex >= openSlots.length) {
          results.push({ rowId: row.rowId, status: "no_open_slot", warning: "No open slot available for this row." });
          if (!input.allowPartial) {
            throw new EventureServiceError(
              `Row "${row.rowId}" could not be assigned: no open slot available.`,
              422,
            );
          }
          continue;
        }

        const identityInput: AttendeeIdentityInput = {
          firstName: row.firstName,
          lastName: row.lastName,
          email: row.email,
          phone: row.phone,
          company: row.companyName,
          companyId: row.companyId,
          title: row.title,
          source: "bulk_fill",
        };

        let resolveResult: CreateOrUpdateResult;
        try {
          resolveResult = await createOrUpdateAttendee(tx, input.organizationId, identityInput, input.userId);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Identity resolution failed.";
          results.push({ rowId: row.rowId, status: "identity_error", warning: message });
          if (!input.allowPartial) throw err;
          continue;
        }

        const slot = openSlots[slotIndex];
        await tx.eventureAttendeeSlot.update({
          where: { id: slot.id },
          data: { attendeeId: resolveResult.attendee.id },
        });

        results.push({
          rowId: row.rowId,
          attendeeId: resolveResult.attendee.id,
          slotId: slot.id,
          status: "assigned",
          action: resolveResult.action,
        });
        slotIndex++;
      }
    });
  };

  await executeAssignments();
  return results;
}
