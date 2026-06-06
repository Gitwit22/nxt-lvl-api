import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import {
  confirmPaymentAndSyncParticipant,
  createAssignmentForEvent,
  listAttendeesForEvent,
  listAssignmentsForEvent,
  listParticipantsForEvent,
  listPaymentsForEvent,
  listVolunteersForEvent,
  updateAttendeeSlot,
  updateParticipantAttendeeCount,
  updateParticipantFlightAssignment,
} from "../services/workspace.service.js";
import { EventureServiceError } from "../services/eventure-error.js";

const router = express.Router({ mergeParams: true });

function readRouteParam(value: unknown, fieldName: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new EventureServiceError(`${fieldName} is required.`, 400);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return value.trim();
  throw new EventureServiceError("Expected a string value.", 400);
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function handleError(res: express.Response, error: unknown) {
  if (error instanceof EventureServiceError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }

  const message = error instanceof Error ? error.message : "Unknown server error";
  res.status(500).json({ error: message });
}

router.use(requireAuth);

router.get("/payments", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const items = await listPaymentsForEvent(user!.organizationId, eventId);
    res.json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/payments/confirm", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const contactCompanyId = readString(req.body?.contactCompanyId);
    const attendeeCount = readNumber(req.body?.attendeeCount);

    if (!contactCompanyId) {
      throw new EventureServiceError("contactCompanyId is required.", 400);
    }

    if (!Number.isInteger(attendeeCount)) {
      throw new EventureServiceError("attendeeCount must be an integer.", 400);
    }

    const item = await confirmPaymentAndSyncParticipant({
      organizationId: user!.organizationId,
      eventId,
      contactCompanyId,
      attendeeCount,
      amountDue: readNumber(req.body?.amountDue),
      amountPaid: readNumber(req.body?.amountPaid),
      paymentMethod: readNullableString(req.body?.paymentMethod),
      notes: readNullableString(req.body?.notes),
      actorUserId: user!.userId,
      forceRemoveNamedSlots: readBoolean(req.body?.forceRemoveNamedSlots),
    });

    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/participants", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const items = await listParticipantsForEvent(user!.organizationId, eventId);
    res.json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/attendees", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const items = await listAttendeesForEvent(user!.organizationId, eventId);
    res.json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch("/participants/:participantId/flight", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const participantId = readRouteParam(req.params["participantId"], "participantId");
    const flightAssignment = readString(req.body?.flightAssignment);

    if (!flightAssignment) {
      throw new EventureServiceError("flightAssignment is required.", 400);
    }

    const item = await updateParticipantFlightAssignment({
      organizationId: user!.organizationId,
      eventId,
      participantId,
      flightAssignment,
    });

    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch("/participants/:participantId/attendee-count", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const participantId = readRouteParam(req.params["participantId"], "participantId");
    const attendeeCount = readNumber(req.body?.attendeeCount);

    if (!Number.isInteger(attendeeCount)) {
      throw new EventureServiceError("attendeeCount must be an integer.", 400);
    }

    const item = await updateParticipantAttendeeCount({
      organizationId: user!.organizationId,
      eventId,
      participantId,
      attendeeCount,
      forceRemoveNamedSlots: readBoolean(req.body?.forceRemoveNamedSlots),
    });

    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch("/attendee-slots/:slotId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const slotId = readRouteParam(req.params["slotId"], "slotId");

    const item = await updateAttendeeSlot({
      organizationId: user!.organizationId,
      eventId,
      slotId,
      actualName: readNullableString(req.body?.actualName),
      notes: readNullableString(req.body?.notes),
      checkedIn: readBoolean(req.body?.checkedIn),
    });

    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/assignments", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const items = await listAssignmentsForEvent(user!.organizationId, eventId);
    res.json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/assignments", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");

    const targetType = readString(req.body?.targetType) as "participant" | "attendee_slot" | "volunteer" | "staff" | undefined;
    if (!targetType) {
      throw new EventureServiceError("targetType is required.", 400);
    }

    const item = await createAssignmentForEvent({
      organizationId: user!.organizationId,
      eventId,
      assignmentType: readString(req.body?.assignmentType),
      targetType,
      participantId: readString(req.body?.participantId),
      attendeeSlotId: readString(req.body?.attendeeSlotId),
      volunteerNeedId: readString(req.body?.volunteerNeedId),
      staffMemberName: readString(req.body?.staffMemberName),
      title: readString(req.body?.title) ?? "",
      notes: readNullableString(req.body?.notes),
      actorUserId: user!.userId,
    });

    res.status(201).json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/volunteers", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const items = await listVolunteersForEvent(user!.organizationId, eventId);
    res.json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

export { router as eventureWorkspaceRouter };
