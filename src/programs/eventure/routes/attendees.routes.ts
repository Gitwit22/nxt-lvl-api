import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import {
  createAttendeeRegistrationForEvent,
  listAttendeesForEvent,
} from "../services/registration.service.js";
import {
  createOrUpdateAttendee,
  parseEmergencyContact,
  normalizeEmail,
  normalizePhone,
} from "../services/attendee-identity.service.js";
import {
  assignAttendeeToSlot,
} from "../services/attendee-assignment.service.js";
import { prisma } from "../../../core/db/prisma.js";
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

// ─── Attendee search (org-wide, scoped via event org) ────────────────────────

router.get("/search", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = req.params["eventId"];
    const q = readString(req.query["q"] as string | undefined) ?? "";

    // Validate the event belongs to this org
    const event = await prisma.eventureEvent.findFirst({
      where: { id: eventId, organizationId: user!.organizationId },
      select: { id: true },
    });
    if (!event) {
      res.status(404).json({ error: "Event not found." });
      return;
    }

    const attendees = await prisma.eventureAttendee.findMany({
      where: {
        organizationId: user!.organizationId,
        archivedAt: null,
        ...(q
          ? {
              OR: [
                { normalizedEmail: { contains: normalizeEmail(q) ?? q.toLowerCase() } },
                { normalizedPhone: { contains: normalizePhone(q) ?? q } },
                { fullName: { contains: q, mode: "insensitive" } },
                { company: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      take: 20,
      select: {
        id: true, firstName: true, lastName: true, fullName: true,
        email: true, phone: true, company: true, title: true, companyId: true,
        dietaryRestrictions: true, accessibilityNeeds: true, emergencyContact: true,
      },
    });

    // Annotate with event assignment metadata
    const existingSlots = await prisma.eventureAttendeeSlot.findMany({
      where: {
        organizationId: user!.organizationId,
        eventId,
        attendeeId: { in: attendees.map((a) => a.id) },
      },
      select: { attendeeId: true },
    });
    const assignedIds = new Set(existingSlots.map((s) => s.attendeeId).filter(Boolean));

    const eventSlotCounts = await prisma.eventureAttendeeSlot.groupBy({
      by: ["attendeeId"],
      where: {
        organizationId: user!.organizationId,
        attendeeId: { in: attendees.map((a) => a.id) },
      },
      _count: { attendeeId: true },
    });
    const historyMap = new Map(eventSlotCounts.map((r) => [r.attendeeId, r._count.attendeeId]));

    const items = attendees.map((a) => ({
      attendee: a,
      matchReason: "search",
      eventHistoryCount: historyMap.get(a.id) ?? 0,
      alreadyAssignedToEvent: assignedIds.has(a.id),
    }));

    res.json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

// ─── Quick add / resolve attendee ────────────────────────────────────────────

router.post("/quick-add", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = req.params["eventId"];
    const slotId = readString(req.body?.slotId);

    const { attendee, action } = await createOrUpdateAttendee(
      prisma as any,
      user!.organizationId,
      {
        firstName: readString(req.body?.firstName),
        lastName: readString(req.body?.lastName),
        email: readString(req.body?.email),
        phone: readString(req.body?.phone),
        company: readString(req.body?.company),
        companyId: readString(req.body?.companyId),
        title: readString(req.body?.title),
        source: "quick_add",
      },
      user!.userId,
    );

    let assignedSlotId: string | undefined;
    if (slotId) {
      await assignAttendeeToSlot({
        slotId,
        attendeeId: attendee.id,
        eventId,
        organizationId: user!.organizationId,
        userId: user!.userId,
      });
      assignedSlotId = slotId;
    }

    res.status(201).json({ attendee, action, assignedSlotId });
  } catch (error) {
    handleError(res, error);
  }
});

export { router as eventureAttendeesRouter };

// ---------------------------------------------------------------------------
// Global attendee CRUD (org-scoped, not event-scoped)
// Mounted separately at /eventure/attendees/:attendeeId
// ---------------------------------------------------------------------------

const globalRouter = express.Router({ mergeParams: true });
globalRouter.use(requireAuth);

globalRouter.get("/:attendeeId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const attendeeId = req.params["attendeeId"];

    const attendee = await prisma.eventureAttendee.findFirst({
      where: { id: attendeeId, organizationId: user!.organizationId, archivedAt: null },
      include: {
        currentCompany: { select: { id: true, name: true } },
      },
    });
    if (!attendee) {
      res.status(404).json({ error: "Attendee not found." });
      return;
    }
    res.json({ item: attendee });
  } catch (error) {
    handleError(res, error);
  }
});

globalRouter.patch("/:attendeeId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const attendeeId = req.params["attendeeId"];

    const existing = await prisma.eventureAttendee.findFirst({
      where: { id: attendeeId, organizationId: user!.organizationId, archivedAt: null },
    });
    if (!existing) {
      res.status(404).json({ error: "Attendee not found." });
      return;
    }

    const emergencyContactRaw = req.body?.emergencyContact;
    const emergencyContact =
      emergencyContactRaw !== undefined
        ? parseEmergencyContact(emergencyContactRaw)
        : undefined;

    if (emergencyContactRaw !== undefined && emergencyContactRaw !== null && emergencyContact === null) {
      res.status(400).json({ error: "emergencyContact must have name and phone fields." });
      return;
    }

    const nEmail = req.body?.email !== undefined ? normalizeEmail(req.body.email) : undefined;
    const nPhone = req.body?.phone !== undefined ? normalizePhone(req.body.phone) : undefined;

    const updated = await prisma.eventureAttendee.update({
      where: { id: attendeeId },
      data: {
        ...(readString(req.body?.firstName) !== undefined && { firstName: readString(req.body.firstName) }),
        ...(readString(req.body?.lastName) !== undefined && { lastName: readString(req.body.lastName) }),
        ...(readString(req.body?.email) !== undefined && {
          email: readString(req.body.email) ?? null,
          normalizedEmail: nEmail,
        }),
        ...(readString(req.body?.phone) !== undefined && {
          phone: readString(req.body.phone) ?? null,
          normalizedPhone: nPhone,
        }),
        ...(readString(req.body?.company) !== undefined && { company: readString(req.body.company) ?? null }),
        ...(readString(req.body?.companyId) !== undefined && { companyId: readString(req.body.companyId) ?? null }),
        ...(readString(req.body?.title) !== undefined && { title: readString(req.body.title) ?? null }),
        ...(req.body?.dietaryRestrictions !== undefined && { dietaryRestrictions: req.body.dietaryRestrictions ?? null }),
        ...(req.body?.accessibilityNeeds !== undefined && { accessibilityNeeds: req.body.accessibilityNeeds ?? null }),
        ...(emergencyContact !== undefined && { emergencyContact: emergencyContact ?? undefined }),
        updatedByUserId: user!.userId,
      },
    });

    res.json({ item: updated });
  } catch (error) {
    handleError(res, error);
  }
});

export { globalRouter as eventureAttendeesGlobalRouter };