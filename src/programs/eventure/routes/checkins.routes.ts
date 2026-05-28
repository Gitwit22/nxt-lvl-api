import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import {
  createCheckInForRegistration,
  createWalkInRegistrationAndCheckIn,
  listCheckInsForOrganizationEvent,
} from "../services/registration.service.js";
import { EventureServiceError } from "../services/eventure-error.js";

const router = express.Router({ mergeParams: true });

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
    const items = await listCheckInsForOrganizationEvent(user!.organizationId, eventId);
    res.json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = req.params["eventId"];
    const registrationId = readString(req.body?.registrationId) ?? "";

    if (!registrationId) {
      throw new EventureServiceError("registrationId is required.", 400);
    }

    const item = await createCheckInForRegistration({
      organizationId: user!.organizationId,
      eventId,
      registrationId,
      checkInType: readString(req.body?.checkInType) ?? "manual",
      checkedInByUserId: user!.userId,
      deviceLabel: readString(req.body?.deviceLabel),
      notes: readString(req.body?.notes),
    });

    res.status(201).json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/manual", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = req.params["eventId"];
    const registrationId = readString(req.body?.registrationId) ?? "";

    if (!registrationId) {
      throw new EventureServiceError("registrationId is required.", 400);
    }

    const item = await createCheckInForRegistration({
      organizationId: user!.organizationId,
      eventId,
      registrationId,
      checkInType: "manual",
      checkedInByUserId: user!.userId,
      deviceLabel: readString(req.body?.deviceLabel),
      notes: readString(req.body?.notes),
    });

    res.status(201).json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/walk-in", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = req.params["eventId"];
    const fullName = readString(req.body?.fullName) ?? "";

    if (!fullName) {
      throw new EventureServiceError("fullName is required.", 400);
    }

    const item = await createWalkInRegistrationAndCheckIn({
      organizationId: user!.organizationId,
      eventId,
      fullName,
      email: readString(req.body?.email),
      phone: readString(req.body?.phone),
      company: readString(req.body?.company),
      title: readString(req.body?.title),
      registrationType: readString(req.body?.registrationType),
      actorUserId: user!.userId,
      notes: readString(req.body?.notes),
      paymentStatus: readString(req.body?.paymentStatus),
    });

    res.status(201).json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

export { router as eventureCheckInsRouter };