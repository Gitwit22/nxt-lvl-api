import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import { prisma } from "../../../db.js";
import { EventureServiceError } from "../services/eventure-error.js";

const router = express.Router();

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

function readInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) ? parsed : undefined;
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

// Create order (registrations)
router.post("/", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const organizerId = readString(req.body?.organizerId);
    const eventId = readString(req.body?.eventId);
    const buyerName = readString(req.body?.buyerName);
    const buyerEmail = readString(req.body?.buyerEmail);
    const buyerPhone = readString(req.body?.buyerPhone);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];

    if (!organizerId || !eventId || !buyerName || !buyerEmail) {
      return res.status(400).json({ error: "organizerId, eventId, buyerName, and buyerEmail are required." });
    }

    if (items.length === 0) {
      return res.status(400).json({ error: "At least one item is required." });
    }

    // Verify event exists
    const event = await prisma.eventureEvent.findFirst({
      where: {
        id: eventId,
        organizationId: user!.organizationId,
      },
    });

    if (!event) {
      return res.status(404).json({ error: "Event not found." });
    }

    // Create unique order number
    const orderNumber = `ORD-${Date.now()}-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;

    // Create attendee if needed
    let attendee = await prisma.eventureAttendee.findFirst({
      where: {
        organizationId: user!.organizationId,
        email: buyerEmail,
      },
    });

    if (!attendee) {
      attendee = await prisma.eventureAttendee.create({
        data: {
          organizationId: user!.organizationId,
          fullName: buyerName,
          email: buyerEmail,
          phone: buyerPhone,
        },
      });
    }

    // Create registrations for each item
    const registrations = await Promise.all(
      items.map((item: any) =>
        prisma.eventureRegistration.create({
          data: {
            organizationId: user!.organizationId,
            eventId,
            attendeeId: attendee!.id,
            ticketTypeId: readString(item.ticketTypeId),
            registrationStatus: "registered",
            paymentStatus: "unpaid",
            amountExpected: readFloat(item.subtotal) ?? 0,
            createdByUserId: user!.userId,
          },
        }),
      ),
    );

    const totalAmount = items.reduce((sum: number, item: any) => sum + (readFloat(item.subtotal) ?? 0), 0);
    const platformFee = readFloat(req.body?.platformFee) ?? Number((totalAmount * 0.05).toFixed(2));
    const total = totalAmount + platformFee;

    res.status(201).json({
      order: {
        orderNumber,
        eventId,
        attendeeId: attendee.id,
        registrations,
        subtotal: totalAmount,
        platformFee,
        total,
        paymentStatus: "unpaid",
        createdAt: new Date(),
      },
    });
  } catch (error) {
    handleError(res, error);
  }
});

// Confirm order (mark as paid)
router.post("/:orderId/confirm", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const paymentStatus = readString(req.body?.paymentStatus) ?? "paid";
    const paymentReference = readString(req.body?.paymentReference);

    // The orderId in this context is actually a registration ID
    const registration = await prisma.eventureRegistration.findFirst({
      where: {
        id: req.params.orderId,
        organizationId: user!.organizationId,
      },
      include: {
        event: true,
        attendee: true,
      },
    });

    if (!registration) {
      return res.status(404).json({ error: "Order not found." });
    }

    const updated = await prisma.eventureRegistration.update({
      where: { id: req.params.orderId },
      data: {
        paymentStatus,
        paymentReference,
        paymentRecordedAt: new Date(),
        paymentRecordedByUserId: user!.userId,
      },
      include: {
        event: true,
        attendee: true,
      },
    });

    // Get related registrations for the same attendee/event to return as order
    const relatedRegistrations = await prisma.eventureRegistration.findMany({
      where: {
        attendeeId: registration.attendeeId,
        eventId: registration.eventId,
        organizationId: user!.organizationId,
      },
    });

    const totalAmount = relatedRegistrations.reduce((sum, reg) => sum + reg.amountExpected, 0);

    res.json({
      orderNumber: `ORD-${updated.createdAt.getTime()}-${updated.id.substring(0, 8).toUpperCase()}`,
      eventId: updated.eventId,
      attendeeId: updated.attendeeId,
      items: relatedRegistrations,
      subtotal: totalAmount,
      total: totalAmount,
      paymentStatus: updated.paymentStatus,
      paymentReference: updated.paymentReference,
      createdAt: updated.createdAt,
    });
  } catch (error) {
    handleError(res, error);
  }
});

// Get order (registration)
router.get("/:orderId", async (req, res) => {
  try {
    const user = getRequestUser(req);

    const registration = await prisma.eventureRegistration.findFirst({
      where: {
        id: req.params.orderId,
        organizationId: user!.organizationId,
      },
      include: {
        event: true,
        attendee: true,
        ticketType: true,
      },
    });

    if (!registration) {
      return res.status(404).json({ error: "Order not found." });
    }

    res.json({ item: registration });
  } catch (error) {
    handleError(res, error);
  }
});

// List orders for event
router.get("/by-event/:eventId", async (req, res) => {
  try {
    const user = getRequestUser(req);

    // Verify event exists
    const event = await prisma.eventureEvent.findFirst({
      where: {
        id: req.params.eventId,
        organizationId: user!.organizationId,
      },
    });

    if (!event) {
      return res.status(404).json({ error: "Event not found." });
    }

    const registrations = await prisma.eventureRegistration.findMany({
      where: {
        eventId: req.params.eventId,
        organizationId: user!.organizationId,
      },
      include: {
        attendee: true,
        ticketType: true,
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({ items: registrations });
  } catch (error) {
    handleError(res, error);
  }
});

// Update ticket type
router.patch("/ticket-types/:ticketTypeId", async (req, res) => {
  try {
    const user = getRequestUser(req);

    const ticketType = await prisma.eventureTicketType.findFirst({
      where: {
        id: req.params.ticketTypeId,
        organizationId: user!.organizationId,
      },
    });

    if (!ticketType) {
      return res.status(404).json({ error: "Ticket type not found." });
    }

    const updated = await prisma.eventureTicketType.update({
      where: { id: req.params.ticketTypeId },
      data: {
        name: readString(req.body?.name),
        description: req.body?.description === null ? null : readString(req.body?.description),
        price: req.body?.price !== undefined ? parseFloat(req.body.price) : undefined,
        capacity: req.body?.capacity === null ? null : readInteger(req.body?.capacity),
        quantityAvailable: readInteger(req.body?.quantityAvailable),
        isPaid: req.body?.isPaid,
        isPublic: req.body?.isPublic,
        sortOrder: readInteger(req.body?.sortOrder),
      },
    });

    res.json({ item: updated });
  } catch (error) {
    handleError(res, error);
  }
});

export { router as ordersRouter };
