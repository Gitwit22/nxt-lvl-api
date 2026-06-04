import { prisma } from "../../../core/db/prisma.js";
import { EventureServiceError } from "./eventure-error.js";

const VALID_TASK_STATUSES = new Set(["OPEN", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"]);
const VALID_TASK_PRIORITIES = new Set(["LOW", "NORMAL", "HIGH", "URGENT"]);
const VALID_TASK_SOURCES = new Set([
  "MANUAL",
  "EVENT",
  "PARTICIPANT",
  "ATTENDEE",
  "SPONSOR",
  "VOLUNTEER_NEED",
  "CHECK_IN",
  "IMPORT",
  "PAYMENT",
  "FOLLOW_UP",
]);

type TaskStatus = "OPEN" | "IN_PROGRESS" | "BLOCKED" | "DONE" | "CANCELLED";
type TaskPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
type TaskSourceType =
  | "MANUAL"
  | "EVENT"
  | "PARTICIPANT"
  | "ATTENDEE"
  | "SPONSOR"
  | "VOLUNTEER_NEED"
  | "CHECK_IN"
  | "IMPORT"
  | "PAYMENT"
  | "FOLLOW_UP";

type TaskFilters = {
  eventId?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignedToUserId?: string;
  sourceType?: TaskSourceType;
  sourceId?: string;
  dueBefore?: Date;
  dueAfter?: Date;
};

type CreateTaskInput = {
  organizationId: string;
  createdByUserId: string;
  eventId?: string;
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignedToUserId?: string;
  assignedToName?: string;
  dueDate?: Date;
  completedAt?: Date;
  sourceType?: TaskSourceType;
  sourceId?: string;
  sourceLabel?: string;
};

type UpdateTaskInput = {
  title?: string;
  description?: string | null;
  eventId?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignedToUserId?: string | null;
  assignedToName?: string | null;
  dueDate?: Date | null;
  completedAt?: Date | null;
  sourceType?: TaskSourceType | null;
  sourceId?: string | null;
  sourceLabel?: string | null;
};

function normalizeStatus(value: unknown): TaskStatus | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim().toUpperCase();
  if (!VALID_TASK_STATUSES.has(normalized)) {
    throw new EventureServiceError("status must be one of OPEN, IN_PROGRESS, BLOCKED, DONE, CANCELLED.", 400);
  }
  return normalized as TaskStatus;
}

function normalizePriority(value: unknown): TaskPriority | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim().toUpperCase();
  if (!VALID_TASK_PRIORITIES.has(normalized)) {
    throw new EventureServiceError("priority must be one of LOW, NORMAL, HIGH, URGENT.", 400);
  }
  return normalized as TaskPriority;
}

function normalizeSourceType(value: unknown): TaskSourceType | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim().toUpperCase();
  if (!VALID_TASK_SOURCES.has(normalized)) {
    throw new EventureServiceError(
      "sourceType must be one of MANUAL, EVENT, PARTICIPANT, ATTENDEE, SPONSOR, VOLUNTEER_NEED, CHECK_IN, IMPORT, PAYMENT, FOLLOW_UP.",
      400,
    );
  }
  return normalized as TaskSourceType;
}

function taskStore() {
  return prisma as unknown as {
    eventureTask: {
      findMany: (args: Record<string, unknown>) => Promise<any[]>;
      findFirst: (args: Record<string, unknown>) => Promise<any | null>;
      create: (args: Record<string, unknown>) => Promise<any>;
      update: (args: Record<string, unknown>) => Promise<any>;
    };
  };
}

export function parseTaskFilters(raw: Record<string, unknown>): TaskFilters {
  const dueBeforeRaw = raw["dueBefore"];
  const dueAfterRaw = raw["dueAfter"];

  const dueBefore = typeof dueBeforeRaw === "string" && dueBeforeRaw.trim() ? new Date(dueBeforeRaw) : undefined;
  const dueAfter = typeof dueAfterRaw === "string" && dueAfterRaw.trim() ? new Date(dueAfterRaw) : undefined;

  if (dueBefore && Number.isNaN(dueBefore.getTime())) {
    throw new EventureServiceError("dueBefore must be a valid ISO date string.", 400);
  }

  if (dueAfter && Number.isNaN(dueAfter.getTime())) {
    throw new EventureServiceError("dueAfter must be a valid ISO date string.", 400);
  }

  return {
    eventId: typeof raw["eventId"] === "string" && raw["eventId"].trim() ? raw["eventId"].trim() : undefined,
    status: normalizeStatus(raw["status"]),
    priority: normalizePriority(raw["priority"]),
    assignedToUserId:
      typeof raw["assignedToUserId"] === "string" && raw["assignedToUserId"].trim()
        ? raw["assignedToUserId"].trim()
        : undefined,
    sourceType: normalizeSourceType(raw["sourceType"]),
    sourceId: typeof raw["sourceId"] === "string" && raw["sourceId"].trim() ? raw["sourceId"].trim() : undefined,
    dueBefore,
    dueAfter,
  };
}

export async function listTasksForOrganization(organizationId: string, filters: TaskFilters = {}) {
  const where: Record<string, unknown> = {
    organizationId,
    archivedAt: null,
  };

  if (filters.eventId) where["eventId"] = filters.eventId;
  if (filters.status) where["status"] = filters.status;
  if (filters.priority) where["priority"] = filters.priority;
  if (filters.assignedToUserId) where["assignedToUserId"] = filters.assignedToUserId;
  if (filters.sourceType) where["sourceType"] = filters.sourceType;
  if (filters.sourceId) where["sourceId"] = filters.sourceId;

  if (filters.dueBefore || filters.dueAfter) {
    where["dueDate"] = {
      ...(filters.dueBefore ? { lte: filters.dueBefore } : {}),
      ...(filters.dueAfter ? { gte: filters.dueAfter } : {}),
    };
  }

  return taskStore().eventureTask.findMany({
    where,
    orderBy: [{ status: "asc" }, { priority: "desc" }, { dueDate: "asc" }, { updatedAt: "desc" }],
  });
}

export async function getTaskForOrganization(organizationId: string, taskId: string) {
  const task = await taskStore().eventureTask.findFirst({
    where: {
      id: taskId,
      organizationId,
      archivedAt: null,
    },
  });

  if (!task) {
    throw new EventureServiceError("Task not found.", 404);
  }

  return task;
}

export async function createTaskForOrganization(input: CreateTaskInput) {
  if (!input.title.trim()) {
    throw new EventureServiceError("title is required.", 400);
  }

  return taskStore().eventureTask.create({
    data: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      title: input.title.trim(),
      description: input.description?.trim() || null,
      status: input.status ?? "OPEN",
      priority: input.priority ?? "NORMAL",
      assignedToUserId: input.assignedToUserId,
      assignedToName: input.assignedToName,
      dueDate: input.dueDate,
      completedAt: input.completedAt,
      sourceType: input.sourceType ?? "MANUAL",
      sourceId: input.sourceId,
      sourceLabel: input.sourceLabel,
      createdByUserId: input.createdByUserId,
    },
  });
}

export async function updateTaskForOrganization(organizationId: string, taskId: string, patch: UpdateTaskInput) {
  await getTaskForOrganization(organizationId, taskId);

  const data: Record<string, unknown> = {};
  if (patch.title !== undefined) data["title"] = patch.title.trim();
  if (patch.description !== undefined) data["description"] = patch.description?.trim() || null;
  if (patch.eventId !== undefined) data["eventId"] = patch.eventId;
  if (patch.status !== undefined) data["status"] = patch.status;
  if (patch.priority !== undefined) data["priority"] = patch.priority;
  if (patch.assignedToUserId !== undefined) data["assignedToUserId"] = patch.assignedToUserId;
  if (patch.assignedToName !== undefined) data["assignedToName"] = patch.assignedToName;
  if (patch.dueDate !== undefined) data["dueDate"] = patch.dueDate;
  if (patch.completedAt !== undefined) data["completedAt"] = patch.completedAt;
  if (patch.sourceType !== undefined) data["sourceType"] = patch.sourceType;
  if (patch.sourceId !== undefined) data["sourceId"] = patch.sourceId;
  if (patch.sourceLabel !== undefined) data["sourceLabel"] = patch.sourceLabel;

  if (patch.status === "DONE" && patch.completedAt === undefined) {
    data["completedAt"] = new Date();
  }

  return taskStore().eventureTask.update({
    where: { id: taskId },
    data,
  });
}

export async function deleteTaskForOrganization(organizationId: string, taskId: string) {
  await getTaskForOrganization(organizationId, taskId);

  return taskStore().eventureTask.update({
    where: { id: taskId },
    data: {
      archivedAt: new Date(),
      status: "CANCELLED",
    },
  });
}
