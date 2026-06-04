import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import { EventureServiceError } from "../services/eventure-error.js";
import {
  createTaskForOrganization,
  deleteTaskForOrganization,
  getTaskForOrganization,
  listTasksForOrganization,
  parseTaskFilters,
  updateTaskForOrganization,
} from "../services/task.service.js";

const router = express.Router();

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return value.trim();
  throw new EventureServiceError("Expected a string value.", 400);
}

function optionalDate(value: unknown, fieldName: string): Date | undefined {
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

function nullableDate(value: unknown, fieldName: string): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
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
    const filters = parseTaskFilters(req.query as Record<string, unknown>);
    const items = await listTasksForOrganization(user!.organizationId, filters);
    res.json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/:taskId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const item = await getTaskForOrganization(user!.organizationId, req.params["taskId"]);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const title = optionalString(req.body?.title);
    if (!title) {
      throw new EventureServiceError("title is required.", 400);
    }

    const item = await createTaskForOrganization({
      organizationId: user!.organizationId,
      createdByUserId: user!.userId,
      eventId: optionalString(req.body?.eventId),
      title,
      description: optionalString(req.body?.description),
      status: optionalString(req.body?.status) as
        | "OPEN"
        | "IN_PROGRESS"
        | "BLOCKED"
        | "DONE"
        | "CANCELLED"
        | undefined,
      priority: optionalString(req.body?.priority) as "LOW" | "NORMAL" | "HIGH" | "URGENT" | undefined,
      assignedToUserId: optionalString(req.body?.assignedToUserId),
      assignedToName: optionalString(req.body?.assignedToName),
      dueDate: optionalDate(req.body?.dueDate, "dueDate"),
      completedAt: optionalDate(req.body?.completedAt, "completedAt"),
      sourceType: optionalString(req.body?.sourceType) as
        | "MANUAL"
        | "EVENT"
        | "PARTICIPANT"
        | "ATTENDEE"
        | "SPONSOR"
        | "VOLUNTEER_NEED"
        | "CHECK_IN"
        | "IMPORT"
        | "PAYMENT"
        | "FOLLOW_UP"
        | undefined,
      sourceId: optionalString(req.body?.sourceId),
      sourceLabel: optionalString(req.body?.sourceLabel),
    });

    res.status(201).json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch("/:taskId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const item = await updateTaskForOrganization(user!.organizationId, req.params["taskId"], {
      eventId: nullableString(req.body?.eventId),
      title: optionalString(req.body?.title),
      description: nullableString(req.body?.description),
      status: optionalString(req.body?.status) as
        | "OPEN"
        | "IN_PROGRESS"
        | "BLOCKED"
        | "DONE"
        | "CANCELLED"
        | undefined,
      priority: optionalString(req.body?.priority) as "LOW" | "NORMAL" | "HIGH" | "URGENT" | undefined,
      assignedToUserId: nullableString(req.body?.assignedToUserId),
      assignedToName: nullableString(req.body?.assignedToName),
      dueDate: nullableDate(req.body?.dueDate, "dueDate"),
      completedAt: nullableDate(req.body?.completedAt, "completedAt"),
      sourceType: nullableString(req.body?.sourceType) as
        | "MANUAL"
        | "EVENT"
        | "PARTICIPANT"
        | "ATTENDEE"
        | "SPONSOR"
        | "VOLUNTEER_NEED"
        | "CHECK_IN"
        | "IMPORT"
        | "PAYMENT"
        | "FOLLOW_UP"
        | null
        | undefined,
      sourceId: nullableString(req.body?.sourceId),
      sourceLabel: nullableString(req.body?.sourceLabel),
    });
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.delete("/:taskId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const item = await deleteTaskForOrganization(user!.organizationId, req.params["taskId"]);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

export { router as eventureTasksRouter };
