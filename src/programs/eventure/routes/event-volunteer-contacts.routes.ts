import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import { prisma } from "../../../core/db/prisma.js";

const router = express.Router({ mergeParams: true });

function handleError(res: express.Response, error: unknown) {
  console.error("[eventure:event-volunteer-contacts]", error);
  res.status(500).json({ error: "Internal server error" });
}

function readRouteParam(value: unknown, fieldName: string): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

router.get("/", requireAuth, async (req, res) => {
  try {
    const user = getRequestUser(req);
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const eventId = readRouteParam(req.params["eventId"], "eventId");
    if (!eventId) {
      res.status(400).json({ error: "eventId is required" });
      return;
    }

    const items = await prisma.eventureEventVolunteerContact.findMany({
      where: {
        organizationId: user.organizationId,
        eventId,
        archivedAt: null,
      },
      orderBy: [{ name: "asc" }, { pulledAt: "desc" }],
    });

    res.json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/pull", requireAuth, async (req, res) => {
  try {
    const user = getRequestUser(req);
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const eventId = readRouteParam(req.params["eventId"], "eventId");
    if (!eventId) {
      res.status(400).json({ error: "eventId is required" });
      return;
    }

    const volunteerContactId = readRouteParam(req.body?.volunteerContactId, "volunteerContactId");
    if (!volunteerContactId) {
      res.status(400).json({ error: "volunteerContactId is required" });
      return;
    }

    const event = await prisma.eventureEvent.findFirst({
      where: {
        id: eventId,
        organizationId: user.organizationId,
        archivedAt: null,
      },
      select: { id: true },
    });

    if (!event) {
      res.status(404).json({ error: "Event not found" });
      return;
    }

    const source = await prisma.eventureVolunteerContact.findFirst({
      where: {
        id: volunteerContactId,
        organizationId: user.organizationId,
        archivedAt: null,
      },
    });

    if (!source) {
      res.status(404).json({ error: "Volunteer contact not found" });
      return;
    }

    const existing = await prisma.eventureEventVolunteerContact.findFirst({
      where: {
        organizationId: user.organizationId,
        eventId,
        sourceVolunteerContactId: volunteerContactId,
      },
    });

    if (existing && !existing.archivedAt) {
      res.status(409).json({ error: "Volunteer contact already pulled to this event" });
      return;
    }

    const item = existing
      ? await prisma.eventureEventVolunteerContact.update({
        where: { id: existing.id },
        data: {
          name: source.name,
          email: source.email,
          phone: source.phone,
          skills: source.skills,
          notes: source.notes,
          pulledAt: new Date(),
          pulledByUserId: user.userId,
          archivedAt: null,
        },
      })
      : await prisma.eventureEventVolunteerContact.create({
        data: {
          organizationId: user.organizationId,
          eventId,
          sourceVolunteerContactId: source.id,
          name: source.name,
          email: source.email,
          phone: source.phone,
          skills: source.skills,
          notes: source.notes,
          pulledByUserId: user.userId,
        },
      });

    res.status(201).json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.delete("/:eventVolunteerContactId", requireAuth, async (req, res) => {
  try {
    const user = getRequestUser(req);
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const eventVolunteerContactId = readRouteParam(req.params["eventVolunteerContactId"], "eventVolunteerContactId");

    if (!eventId || !eventVolunteerContactId) {
      res.status(400).json({ error: "eventId and eventVolunteerContactId are required" });
      return;
    }

    const existing = await prisma.eventureEventVolunteerContact.findFirst({
      where: {
        id: eventVolunteerContactId,
        eventId,
        organizationId: user.organizationId,
        archivedAt: null,
      },
      select: { id: true },
    });

    if (!existing) {
      res.status(404).json({ error: "Event volunteer contact not found" });
      return;
    }

    await prisma.eventureEventVolunteerContact.update({
      where: { id: eventVolunteerContactId },
      data: { archivedAt: new Date() },
    });

    res.json({ ok: true });
  } catch (error) {
    handleError(res, error);
  }
});

export { router as eventureEventVolunteerContactsRouter };
