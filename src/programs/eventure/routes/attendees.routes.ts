import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import {
  createAttendeeRegistrationForEvent,
  listAttendeesForEvent,
} from "../services/registration.service.js";
import { EventureServiceError } from "../services/eventure-error.js";

const router = express.Router({ mergeParams: true });

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readFloat(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
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

router.get("/", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = req.params["eventId"];
    const items = await listAttendeesForEvent(user!.organizationId, eventId);
    res.json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = req.params["eventId"];
    const fullName = readString(req.body?.fullName) ?? "";

    const item = await createAttendeeRegistrationForEvent({
      organizationId: user!.organizationId,
      eventId,
      createdByUserId: user!.userId,
      firstName: readString(req.body?.firstName),
      lastName: readString(req.body?.lastName),
      fullName,
      email: readString(req.body?.email),
      phone: readString(req.body?.phone),
      company: readString(req.body?.company),
      title: readString(req.body?.title),
      tags: Array.isArray(req.body?.tags) ? req.body.tags : [],
      attendeeSource: readString(req.body?.attendeeSource),
      attendeeNotes: readString(req.body?.attendeeNotes),
      registrationType: readString(req.body?.registrationType),
      registrationStatus: readString(req.body?.registrationStatus),
      paymentStatus: readString(req.body?.paymentStatus),
      ticketTypeId: readString(req.body?.ticketTypeId),
      groupId: readString(req.body?.groupId),
      householdId: readString(req.body?.householdId),
      amountExpected: readFloat(req.body?.amountExpected),
      amountPaid: readFloat(req.body?.amountPaid),
      paymentMethod: readString(req.body?.paymentMethod),
      paymentReference: readString(req.body?.paymentReference),
      paymentNotes: readString(req.body?.paymentNotes),
      source: readString(req.body?.source),
      importBatchId: readString(req.body?.importBatchId),
      notes: readString(req.body?.notes),
    });

    res.status(201).json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

export { router as eventureAttendeesRouter };