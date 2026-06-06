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

function readNullableFloat(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
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

// List packages for an event
router.get("/", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const items = await prisma.eventureSponsorshipPackage.findMany({
      where: { organizationId: user!.organizationId, eventId, archivedAt: null },
      orderBy: [{ regularPrice: "asc" }, { name: "asc" }],
    });
    res.json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

// Create / upsert a package
router.post("/", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const body = req.body as Record<string, unknown>;
    const name = readString(body.name);
    if (!name) {
      res.status(400).json({ error: "Package name is required." });
      return;
    }
    const item = await prisma.eventureSponsorshipPackage.upsert({
      where: {
        organizationId_eventId_name: {
          organizationId: user!.organizationId,
          eventId,
          name,
        },
      },
      update: {
        earlyBirdPrice: readNullableFloat(body.earlyBirdPrice) ?? undefined,
        regularPrice: readNullableFloat(body.regularPrice) ?? undefined,
        archivedAt: null,
      },
      create: {
        organizationId: user!.organizationId,
        eventId,
        name,
        earlyBirdPrice: readNullableFloat(body.earlyBirdPrice) ?? undefined,
        regularPrice: readNullableFloat(body.regularPrice) ?? undefined,
      },
    });
    res.status(201).json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

// Update a package
router.patch("/:packageId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const packageId = readRouteParam(req.params["packageId"], "packageId");
    const body = req.body as Record<string, unknown>;

    const existing = await prisma.eventureSponsorshipPackage.findFirst({
      where: { id: packageId, organizationId: user!.organizationId, eventId, archivedAt: null },
    });
    if (!existing) {
      res.status(404).json({ error: "Package not found." });
      return;
    }

    const name = readString(body.name);
    const earlyBirdPrice = readNullableFloat(body.earlyBirdPrice);
    const regularPrice = readNullableFloat(body.regularPrice);

    const item = await prisma.eventureSponsorshipPackage.update({
      where: { id: packageId },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(earlyBirdPrice !== undefined ? { earlyBirdPrice } : {}),
        ...(regularPrice !== undefined ? { regularPrice } : {}),
      },
    });
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

// Archive a package
router.delete("/:packageId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const packageId = readRouteParam(req.params["packageId"], "packageId");

    const existing = await prisma.eventureSponsorshipPackage.findFirst({
      where: { id: packageId, organizationId: user!.organizationId, eventId, archivedAt: null },
    });
    if (!existing) {
      res.status(404).json({ error: "Package not found." });
      return;
    }

    await prisma.eventureSponsorshipPackage.update({
      where: { id: packageId },
      data: { archivedAt: new Date() },
    });
    res.json({ success: true });
  } catch (error) {
    handleError(res, error);
  }
});

export { router as eventurePackagesRouter };
