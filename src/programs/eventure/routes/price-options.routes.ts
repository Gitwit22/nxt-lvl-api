import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import { prisma } from "../../../core/db/prisma.js";
import { EventureServiceError } from "../services/eventure-error.js";

const router = express.Router({ mergeParams: true });

function readRouteParam(value: unknown, fieldName: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new EventureServiceError(`${fieldName} is required.`, 400);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return value.trim();
  throw new EventureServiceError("Expected a string value.", 400);
}

function readInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return undefined;
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

function handleError(res: express.Response, error: unknown) {
  if (error instanceof EventureServiceError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : "Unknown server error";
  res.status(500).json({ error: message });
}

router.use(requireAuth);

// List all active price options for an event, ordered by sortOrder then name
router.get("/", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const items = await prisma.eventPriceOption.findMany({
      where: { organizationId: user!.organizationId, eventId, archivedAt: null },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
    res.json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

// Get a single price option
router.get("/:optionId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const optionId = readRouteParam(req.params["optionId"], "optionId");
    const item = await prisma.eventPriceOption.findFirst({
      where: { id: optionId, organizationId: user!.organizationId, eventId, archivedAt: null },
    });
    if (!item) {
      res.status(404).json({ error: "Price option not found." });
      return;
    }
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

// Create a price option
router.post("/", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const body = req.body as Record<string, unknown>;

    const code = readString(body.code);
    const name = readString(body.name);
    const category = readString(body.category);

    if (!code) throw new EventureServiceError("code is required.", 400);
    if (!name) throw new EventureServiceError("name is required.", 400);
    if (!category) throw new EventureServiceError("category is required.", 400);

    const priceCents = readInt(body.priceCents) ?? 0;

    const event = await prisma.eventureEvent.findFirst({
      where: { id: eventId, organizationId: user!.organizationId },
    });
    if (!event) throw new EventureServiceError("Event not found.", 404);

    const item = await prisma.eventPriceOption.create({
      data: {
        organizationId: user!.organizationId,
        eventId,
        code,
        name,
        category,
        flight: readNullableString(body.flight) ?? null,
        priceCents,
        includedFoursomes: readInt(body.includedFoursomes) ?? 0,
        includedGolfers: readInt(body.includedGolfers) ?? 0,
        includedNonGolfers: readInt(body.includedNonGolfers) ?? 0,
        includedAttendeeSlots: readInt(body.includedAttendeeSlots) ?? 0,
        includedRepresentativeSlots: readInt(body.includedRepresentativeSlots) ?? 0,
        participantEligible: readBoolean(body.participantEligible) ?? true,
        createsSponsorRecord: readBoolean(body.createsSponsorRecord) ?? false,
        isLimited: readBoolean(body.isLimited) ?? false,
        isActive: readBoolean(body.isActive) ?? true,
        requiresReview: readBoolean(body.requiresReview) ?? false,
        reviewNote: readNullableString(body.reviewNote) ?? null,
        description: readNullableString(body.description) ?? null,
        benefits: (body.benefits ?? null) as object | null,
        sortOrder: readInt(body.sortOrder) ?? 0,
      },
    });
    res.status(201).json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

// Update a price option
router.patch("/:optionId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const optionId = readRouteParam(req.params["optionId"], "optionId");
    const body = req.body as Record<string, unknown>;

    const existing = await prisma.eventPriceOption.findFirst({
      where: { id: optionId, organizationId: user!.organizationId, eventId, archivedAt: null },
    });
    if (!existing) throw new EventureServiceError("Price option not found.", 404);

    const name = readString(body.name);
    const category = readString(body.category);
    const flight = readNullableString(body.flight);
    const priceCents = readInt(body.priceCents);
    const includedFoursomes = readInt(body.includedFoursomes);
    const includedGolfers = readInt(body.includedGolfers);
    const includedNonGolfers = readInt(body.includedNonGolfers);
    const includedAttendeeSlots = readInt(body.includedAttendeeSlots);
    const includedRepresentativeSlots = readInt(body.includedRepresentativeSlots);
    const participantEligible = readBoolean(body.participantEligible);
    const createsSponsorRecord = readBoolean(body.createsSponsorRecord);
    const isLimited = readBoolean(body.isLimited);
    const isActive = readBoolean(body.isActive);
    const requiresReview = readBoolean(body.requiresReview);
    const reviewNote = readNullableString(body.reviewNote);
    const description = readNullableString(body.description);
    const sortOrder = readInt(body.sortOrder);

    const item = await prisma.eventPriceOption.update({
      where: { id: optionId },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(category !== undefined ? { category } : {}),
        ...(flight !== undefined ? { flight } : {}),
        ...(priceCents !== undefined ? { priceCents } : {}),
        ...(includedFoursomes !== undefined ? { includedFoursomes } : {}),
        ...(includedGolfers !== undefined ? { includedGolfers } : {}),
        ...(includedNonGolfers !== undefined ? { includedNonGolfers } : {}),
        ...(includedAttendeeSlots !== undefined ? { includedAttendeeSlots } : {}),
        ...(includedRepresentativeSlots !== undefined ? { includedRepresentativeSlots } : {}),
        ...(participantEligible !== undefined ? { participantEligible } : {}),
        ...(createsSponsorRecord !== undefined ? { createsSponsorRecord } : {}),
        ...(isLimited !== undefined ? { isLimited } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
        ...(requiresReview !== undefined ? { requiresReview } : {}),
        ...(reviewNote !== undefined ? { reviewNote } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(body.benefits !== undefined ? { benefits: body.benefits as object | null } : {}),
        ...(sortOrder !== undefined ? { sortOrder } : {}),
      },
    });
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

// Archive a price option (soft delete)
router.delete("/:optionId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const optionId = readRouteParam(req.params["optionId"], "optionId");

    const existing = await prisma.eventPriceOption.findFirst({
      where: { id: optionId, organizationId: user!.organizationId, eventId, archivedAt: null },
    });
    if (!existing) throw new EventureServiceError("Price option not found.", 404);

    await prisma.eventPriceOption.update({
      where: { id: optionId },
      data: { archivedAt: new Date() },
    });
    res.json({ success: true });
  } catch (error) {
    handleError(res, error);
  }
});

export { router as eventurePriceOptionsRouter };
