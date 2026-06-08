import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import { prisma } from "../../../core/db/prisma.js";

const router = express.Router({ mergeParams: true });

const VALID_EVENT_ROLES = ["event_manager", "event_operator"] as const;
type EventRole = (typeof VALID_EVENT_ROLES)[number];

function handleError(res: express.Response, error: unknown) {
  console.error("[eventure:event-personnel]", error);
  res.status(500).json({ error: "Internal server error" });
}

// GET /api/eventure/events/:eventId/personnel — list personnel assigned to this event
router.get("/", requireAuth, async (req, res) => {
  try {
    const user = getRequestUser(req);
    if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
    const { eventId } = req.params as { eventId: string };

    const items = await prisma.eventureEventPersonnel.findMany({
      where: { eventId, organizationId: user.organizationId, archivedAt: null },
      include: {
        personnel: { select: { id: true, name: true, email: true, programRole: true, inviteStatus: true, userId: true } },
      },
      orderBy: { assignedAt: "asc" },
    });
    res.json({ items });
  } catch (error) { handleError(res, error); }
});

// POST /api/eventure/events/:eventId/personnel — assign existing personnel to event
router.post("/", requireAuth, async (req, res) => {
  try {
    const user = getRequestUser(req);
    if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
    const { eventId } = req.params as { eventId: string };

    const { personnelId, eventRole } = req.body as { personnelId?: string; eventRole?: string };

    if (!personnelId?.trim()) { res.status(400).json({ error: "personnelId is required" }); return; }
    if (!eventRole || !VALID_EVENT_ROLES.includes(eventRole as EventRole)) {
      res.status(400).json({ error: `eventRole must be one of: ${VALID_EVENT_ROLES.join(", ")}` });
      return;
    }

    // Verify event belongs to org
    const event = await prisma.eventureEvent.findFirst({
      where: { id: eventId, organizationId: user.organizationId, archivedAt: null },
    });
    if (!event) { res.status(404).json({ error: "Event not found" }); return; }

    // Verify personnel belongs to org
    const personnel = await prisma.eventurePersonnel.findFirst({
      where: { id: personnelId.trim(), organizationId: user.organizationId, archivedAt: null },
    });
    if (!personnel) { res.status(404).json({ error: "Personnel not found" }); return; }

    // Upsert: if they already have an assignment, update role; otherwise create
    const assignment = await prisma.eventureEventPersonnel.upsert({
      where: { eventId_personnelId: { eventId, personnelId: personnelId.trim() } },
      create: {
        organizationId: user.organizationId,
        eventId,
        personnelId: personnelId.trim(),
        eventRole: eventRole as EventRole,
        assignedByUserId: user.userId,
      },
      update: {
        eventRole: eventRole as EventRole,
        archivedAt: null,
        assignedByUserId: user.userId,
      },
      include: {
        personnel: { select: { id: true, name: true, email: true, programRole: true, inviteStatus: true, userId: true } },
      },
    });

    res.status(201).json({ item: assignment });
  } catch (error) { handleError(res, error); }
});

// PATCH /api/eventure/events/:eventId/personnel/:personnelId — update event role
router.patch("/:personnelId", requireAuth, async (req, res) => {
  try {
    const user = getRequestUser(req);
    if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
    const { eventId, personnelId } = req.params as { eventId: string; personnelId: string };

    const { eventRole } = req.body as { eventRole?: string };
    if (!eventRole || !VALID_EVENT_ROLES.includes(eventRole as EventRole)) {
      res.status(400).json({ error: `eventRole must be one of: ${VALID_EVENT_ROLES.join(", ")}` });
      return;
    }

    const existing = await prisma.eventureEventPersonnel.findFirst({
      where: { eventId, personnelId, organizationId: user.organizationId, archivedAt: null },
    });
    if (!existing) { res.status(404).json({ error: "Assignment not found" }); return; }

    const updated = await prisma.eventureEventPersonnel.update({
      where: { id: existing.id },
      data: { eventRole: eventRole as EventRole },
      include: {
        personnel: { select: { id: true, name: true, email: true, programRole: true, inviteStatus: true, userId: true } },
      },
    });
    res.json({ item: updated });
  } catch (error) { handleError(res, error); }
});

// DELETE /api/eventure/events/:eventId/personnel/:personnelId — remove from event
router.delete("/:personnelId", requireAuth, async (req, res) => {
  try {
    const user = getRequestUser(req);
    if (!user) { res.status(401).json({ error: "Authentication required" }); return; }
    const { eventId, personnelId } = req.params as { eventId: string; personnelId: string };

    const existing = await prisma.eventureEventPersonnel.findFirst({
      where: { eventId, personnelId, organizationId: user.organizationId, archivedAt: null },
    });
    if (!existing) { res.status(404).json({ error: "Assignment not found" }); return; }

    await prisma.eventureEventPersonnel.update({
      where: { id: existing.id },
      data: { archivedAt: new Date() },
    });
    res.json({ ok: true });
  } catch (error) { handleError(res, error); }
});

export { router as eventureEventPersonnelRouter };
