import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import { EventureServiceError } from "../services/eventure-error.js";
import { EventReportingService, type EventReportFilters } from "../services/event-reporting.service.js";

const router = express.Router({ mergeParams: true });

function setShortLivedReadCache(res: express.Response) {
  res.setHeader("Cache-Control", "private, max-age=15, stale-while-revalidate=45");
}

function readRouteParam(value: unknown, fieldName: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new EventureServiceError(`${fieldName} is required.`, 400);
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

function readStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0);
    return items.length > 0 ? items : undefined;
  }

  if (typeof value === "string" && value.trim()) {
    const items = value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return items.length > 0 ? items : undefined;
  }

  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readFilters(raw: Record<string, unknown>): EventReportFilters {
  const flightRaw = readString(raw["flight"]);
  const normalizedFlight = flightRaw?.toUpperCase();
  const flight = normalizedFlight === "AM" || normalizedFlight === "PM" || normalizedFlight === "UNASSIGNED"
    ? normalizedFlight
    : undefined;

  return {
    paymentStatus: readStringArray(raw["paymentStatus"]),
    packageIds: readStringArray(raw["packageIds"]),
    companyIds: readStringArray(raw["companyIds"]),
    participantStatus: readStringArray(raw["participantStatus"]),
    source: readStringArray(raw["source"]),
    dateFrom: readString(raw["dateFrom"]),
    dateTo: readString(raw["dateTo"]),
    includeArchived: readBoolean(raw["includeArchived"]),
    flight,
  };
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

router.get("/summary", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const item = await EventReportingService.getSummary(
      user!.organizationId,
      eventId,
      readFilters(req.query as Record<string, unknown>),
    );
    setShortLivedReadCache(res);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/financial", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const item = await EventReportingService.getFinancial(
      user!.organizationId,
      eventId,
      readFilters(req.query as Record<string, unknown>),
    );
    setShortLivedReadCache(res);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/financial/reconciliation", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const item = await EventReportingService.getFinancialReconciliation(
      user!.organizationId,
      eventId,
      readFilters(req.query as Record<string, unknown>),
    );
    setShortLivedReadCache(res);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/financial/aging", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const item = await EventReportingService.getFinancialAging(
      user!.organizationId,
      eventId,
      readFilters(req.query as Record<string, unknown>),
    );
    setShortLivedReadCache(res);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/packages", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const item = await EventReportingService.getPackages(
      user!.organizationId,
      eventId,
      readFilters(req.query as Record<string, unknown>),
    );
    setShortLivedReadCache(res);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/participants", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const item = await EventReportingService.getParticipants(
      user!.organizationId,
      eventId,
      readFilters(req.query as Record<string, unknown>),
    );
    setShortLivedReadCache(res);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/attendees", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const item = await EventReportingService.getAttendees(
      user!.organizationId,
      eventId,
      readFilters(req.query as Record<string, unknown>),
    );
    setShortLivedReadCache(res);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/flights", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const item = await EventReportingService.getFlights(
      user!.organizationId,
      eventId,
      readFilters(req.query as Record<string, unknown>),
    );
    setShortLivedReadCache(res);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/check-ins", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const item = await EventReportingService.getCheckIns(
      user!.organizationId,
      eventId,
      readFilters(req.query as Record<string, unknown>),
    );
    setShortLivedReadCache(res);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/follow-ups", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const item = await EventReportingService.getFollowUps(
      user!.organizationId,
      eventId,
      readFilters(req.query as Record<string, unknown>),
    );
    setShortLivedReadCache(res);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/data-quality", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const item = await EventReportingService.getDataQuality(
      user!.organizationId,
      eventId,
      readFilters(req.query as Record<string, unknown>),
    );
    setShortLivedReadCache(res);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/export", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const item = await EventReportingService.getFinancial(
      user!.organizationId,
      eventId,
      readFilters(req.query as Record<string, unknown>),
    );
    setShortLivedReadCache(res);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

export { router as eventureReportsRouter };
