import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import { prisma } from "../../../core/db/prisma.js";

const router = express.Router({ mergeParams: true });

function handleError(res: express.Response, error: unknown) {
  console.error("[eventure:volunteer-contacts]", error);
  res.status(500).json({ error: "Internal server error" });
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  return value.trim() || null;
}

function normalizeSkills(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;

  const deduped = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item.trim();
    if (!normalized) continue;
    deduped.add(normalized);
  }

  return Array.from(deduped);
}

router.get("/", requireAuth, async (req, res) => {
  try {
    const user = getRequestUser(req);
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const includeArchived = req.query.includeArchived === "true";

    const items = await prisma.eventureVolunteerContact.findMany({
      where: {
        organizationId: user.organizationId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ name: "asc" }, { createdAt: "asc" }],
    });

    res.json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const user = getRequestUser(req);
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const name = readString(req.body?.name);
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    const item = await prisma.eventureVolunteerContact.create({
      data: {
        organizationId: user.organizationId,
        name,
        email: readNullableString(req.body?.email) ?? null,
        phone: readNullableString(req.body?.phone) ?? null,
        skills: normalizeSkills(req.body?.skills) ?? [],
        notes: readNullableString(req.body?.notes) ?? null,
      },
    });

    res.status(201).json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch("/:contactId", requireAuth, async (req, res) => {
  try {
    const user = getRequestUser(req);
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const { contactId } = req.params as { contactId: string };
    const existing = await prisma.eventureVolunteerContact.findFirst({
      where: { id: contactId, organizationId: user.organizationId, archivedAt: null },
    });

    if (!existing) {
      res.status(404).json({ error: "Volunteer contact not found" });
      return;
    }

    const updates: {
      name?: string;
      email?: string | null;
      phone?: string | null;
      notes?: string | null;
      skills?: string[];
    } = {};

    const nextName = readString(req.body?.name);
    if (nextName) updates.name = nextName;

    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "email")) {
      updates.email = readNullableString(req.body?.email) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "phone")) {
      updates.phone = readNullableString(req.body?.phone) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "notes")) {
      updates.notes = readNullableString(req.body?.notes) ?? null;
    }

    const nextSkills = normalizeSkills(req.body?.skills);
    if (nextSkills) updates.skills = nextSkills;

    const item = await prisma.eventureVolunteerContact.update({
      where: { id: contactId },
      data: updates,
    });

    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.delete("/:contactId", requireAuth, async (req, res) => {
  try {
    const user = getRequestUser(req);
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const { contactId } = req.params as { contactId: string };
    const existing = await prisma.eventureVolunteerContact.findFirst({
      where: { id: contactId, organizationId: user.organizationId, archivedAt: null },
      select: { id: true },
    });

    if (!existing) {
      res.status(404).json({ error: "Volunteer contact not found" });
      return;
    }

    await prisma.eventureVolunteerContact.update({
      where: { id: contactId },
      data: { archivedAt: new Date() },
    });

    res.json({ ok: true });
  } catch (error) {
    handleError(res, error);
  }
});

export { router as eventureVolunteerContactsRouter };
