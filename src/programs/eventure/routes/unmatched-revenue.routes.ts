import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import {
  ignoreUnmatchedRevenue,
  listUnmatchedRevenueForEvent,
  matchUnmatchedRevenueToParticipant,
} from "../services/participant-revenue-import.service.js";
import { EventureServiceError } from "../services/eventure-error.js";

const router = express.Router({ mergeParams: true });

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRouteParam(value: unknown, fieldName: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new EventureServiceError(`${fieldName} is required.`, 400);
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
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const items = await listUnmatchedRevenueForEvent(user!.organizationId, eventId);
    res.json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/:unmatchedRevenueId/match", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const unmatchedRevenueId = readRouteParam(req.params["unmatchedRevenueId"], "unmatchedRevenueId");
    const participantId = readRouteParam(req.body?.participantId, "participantId");

    const item = await matchUnmatchedRevenueToParticipant({
      organizationId: user!.organizationId,
      eventId,
      unmatchedRevenueId,
      participantId,
      notes: readString(req.body?.notes),
    });

    res.status(200).json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/:unmatchedRevenueId/ignore", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const unmatchedRevenueId = readRouteParam(req.params["unmatchedRevenueId"], "unmatchedRevenueId");

    const item = await ignoreUnmatchedRevenue({
      organizationId: user!.organizationId,
      eventId,
      unmatchedRevenueId,
      notes: readString(req.body?.notes),
    });

    res.status(200).json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

export { router as eventureUnmatchedRevenueRouter };
