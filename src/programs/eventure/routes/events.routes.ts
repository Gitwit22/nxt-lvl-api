import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import {
  archiveEventForOrganization,
  createEventForOrganization,
  getEventForOrganization,
  listEventsForOrganization,
  updateEventForOrganization,
} from "../services/event.service.js";
import { EventureServiceError } from "../services/eventure-error.js";

const router = express.Router();

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readDate(value: unknown, fieldName: string): Date {
  if (typeof value !== "string" || !value.trim()) {
    throw new EventureServiceError(`${fieldName} is required.`, 400);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new EventureServiceError(`${fieldName} must be a valid ISO date string.`, 400);
  }
  return parsed;
}

function readOptionalDate(value: unknown, fieldName: string): Date | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new EventureServiceError(`${fieldName} must be a valid ISO date string.`, 400);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new EventureServiceError(`${fieldName} must be a valid ISO date string.`, 400);
  }
  return parsed;
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
    const events = await listEventsForOrganization(user!.organizationId);
    res.json({ items: events });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const event = await createEventForOrganization({
      organizationId: user!.organizationId,
      createdByUserId: user!.userId,
      title: readString(req.body?.title) ?? "",
      description: readString(req.body?.description),
      eventType: readString(req.body?.eventType),
      status: readString(req.body?.status),
      startDateTime: readDate(req.body?.startDateTime, "startDateTime"),
      endDateTime: readDate(req.body?.endDateTime, "endDateTime"),
      timezone: readString(req.body?.timezone),
      venueName: readString(req.body?.venueName) ?? "",
      addressLine1: readString(req.body?.addressLine1),
      addressLine2: readString(req.body?.addressLine2),
      city: readString(req.body?.city),
      state: readString(req.body?.state),
      zipCode: readString(req.body?.zipCode),
      capacity: readInteger(req.body?.capacity),
      expectedAttendance: readInteger(req.body?.expectedAttendance),
      linkedProgramId: readString(req.body?.linkedProgramId),
      linkedCampaignId: readString(req.body?.linkedCampaignId),
      linkedSponsorId: readString(req.body?.linkedSponsorId),
      notes: readString(req.body?.notes),
    });

    res.status(201).json({ item: event });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/:eventId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const event = await getEventForOrganization(user!.organizationId, req.params.eventId);
    res.json({ item: event });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch("/:eventId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const event = await updateEventForOrganization(user!.organizationId, req.params.eventId, {
      title: readString(req.body?.title),
      description: readString(req.body?.description),
      eventType: readString(req.body?.eventType),
      status: readString(req.body?.status),
      startDateTime: readOptionalDate(req.body?.startDateTime, "startDateTime"),
      endDateTime: readOptionalDate(req.body?.endDateTime, "endDateTime"),
      timezone: readString(req.body?.timezone),
      venueName: readString(req.body?.venueName),
      addressLine1: readString(req.body?.addressLine1),
      addressLine2: readString(req.body?.addressLine2),
      city: readString(req.body?.city),
      state: readString(req.body?.state),
      zipCode: readString(req.body?.zipCode),
      capacity: readInteger(req.body?.capacity),
      expectedAttendance: readInteger(req.body?.expectedAttendance),
      linkedProgramId: readString(req.body?.linkedProgramId),
      linkedCampaignId: readString(req.body?.linkedCampaignId),
      linkedSponsorId: readString(req.body?.linkedSponsorId),
      notes: readString(req.body?.notes),
    });

    res.json({ item: event });
  } catch (error) {
    handleError(res, error);
  }
});

router.delete("/:eventId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const event = await archiveEventForOrganization(user!.organizationId, req.params.eventId);
    res.json({ item: event });
  } catch (error) {
    handleError(res, error);
  }
});

export { router as eventureEventsRouter };