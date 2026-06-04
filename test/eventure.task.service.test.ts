import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  eventureTask: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../src/core/db/prisma.js", () => ({
  prisma: prismaMock,
}));

const {
  createTaskForOrganization,
  deleteTaskForOrganization,
  getTaskForOrganization,
  listTasksForOrganization,
  parseTaskFilters,
  updateTaskForOrganization,
} = await import("../src/programs/eventure/services/task.service.js");
const { EventureServiceError } = await import("../src/programs/eventure/services/eventure-error.js");

describe("eventure task service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses task filters for event/status/priority/sourceType", () => {
    const parsed = parseTaskFilters({
      eventId: "evt-1",
      status: "in_progress",
      priority: "high",
      sourceType: "import",
    });

    expect(parsed).toEqual(
      expect.objectContaining({
        eventId: "evt-1",
        status: "IN_PROGRESS",
        priority: "HIGH",
        sourceType: "IMPORT",
      }),
    );
  });

  it("applies org scoping and filters when listing tasks", async () => {
    prismaMock.eventureTask.findMany.mockResolvedValue([]);

    await listTasksForOrganization("org-1", {
      eventId: "evt-1",
      status: "OPEN",
      priority: "NORMAL",
      sourceType: "CHECK_IN",
    });

    expect(prismaMock.eventureTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          eventId: "evt-1",
          status: "OPEN",
          priority: "NORMAL",
          sourceType: "CHECK_IN",
          archivedAt: null,
        }),
      }),
    );
  });

  it("supports task CRUD for an organization", async () => {
    prismaMock.eventureTask.create.mockResolvedValue({ id: "task-1", title: "Task One" });
    prismaMock.eventureTask.findFirst.mockResolvedValue({ id: "task-1", organizationId: "org-1", archivedAt: null });
    prismaMock.eventureTask.update.mockResolvedValue({ id: "task-1", title: "Updated" });

    const created = await createTaskForOrganization({
      organizationId: "org-1",
      createdByUserId: "user-1",
      title: "Task One",
    });

    expect(created).toEqual(expect.objectContaining({ id: "task-1" }));
    expect(prismaMock.eventureTask.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-1",
          createdByUserId: "user-1",
          title: "Task One",
        }),
      }),
    );

    await updateTaskForOrganization("org-1", "task-1", { status: "DONE" });
    expect(prismaMock.eventureTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-1" },
        data: expect.objectContaining({ status: "DONE" }),
      }),
    );

    await deleteTaskForOrganization("org-1", "task-1");
    expect(prismaMock.eventureTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-1" },
        data: expect.objectContaining({ status: "CANCELLED", archivedAt: expect.any(Date) }),
      }),
    );
  });

  it("enforces org scoping when getting a task", async () => {
    prismaMock.eventureTask.findFirst.mockResolvedValue(null);

    try {
      await getTaskForOrganization("org-2", "task-1");
      throw new Error("Expected getTaskForOrganization to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EventureServiceError);
      expect(error).toMatchObject({ statusCode: 404 });
    }
  });
});
