import express from "express";
import { prisma } from "../db/prisma.js";
import { CURRENT_PROGRAM_DOMAIN } from "../config/env.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { getRequestProgram } from "../middleware/partition.middleware.js";
import { programs } from "../config/programs.js";

const router = express.Router();

type ProgramInput = {
  id?: string;
  slug?: string;
  organizationId?: string | null;
  name?: string;
  shortDescription?: string;
  longDescription?: string;
  category?: string;
  tags?: string[];
  status?: string;
  type?: string;
  origin?: string;
  internalRoute?: string | null;
  externalUrl?: string | null;
  openInNewTab?: boolean;
  logoUrl?: string | null;
  screenshotUrl?: string | null;
  accentColor?: string | null;
  isFeatured?: boolean;
  isPublic?: boolean;
  requiresLogin?: boolean;
  requiresApproval?: boolean;
  launchLabel?: string;
  displayOrder?: number;
  notes?: string;
};

function getProgramDomain(req: express.Request): string {
  return getRequestProgram(req)?.key || CURRENT_PROGRAM_DOMAIN;
}

function getRouteId(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] || "";
  }
  return value || "";
}

function toSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
}

function mapProgram(program: {
  id: string;
  slug: string;
  organizationId: string | null;
  name: string;
  shortDescription: string;
  longDescription: string;
  category: string;
  tags: unknown;
  status: string;
  type: string;
  origin: string;
  internalRoute: string | null;
  externalUrl: string | null;
  openInNewTab: boolean;
  logoUrl: string | null;
  screenshotUrl: string | null;
  accentColor: string | null;
  isFeatured: boolean;
  isPublic: boolean;
  requiresLogin: boolean;
  requiresApproval: boolean;
  launchLabel: string;
  displayOrder: number;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}) {
  return {
    id: program.id,
    slug: program.slug,
    organizationId: program.organizationId,
    name: program.name,
    shortDescription: program.shortDescription,
    longDescription: program.longDescription,
    category: program.category,
    tags: asStringArray(program.tags),
    status: program.status,
    type: program.type,
    origin: program.origin,
    internalRoute: program.internalRoute,
    externalUrl: program.externalUrl,
    openInNewTab: program.openInNewTab,
    logoUrl: program.logoUrl,
    screenshotUrl: program.screenshotUrl,
    accentColor: program.accentColor,
    isFeatured: program.isFeatured,
    isPublic: program.isPublic,
    requiresLogin: program.requiresLogin,
    requiresApproval: program.requiresApproval,
    launchLabel: program.launchLabel,
    displayOrder: program.displayOrder,
    notes: program.notes,
    createdAt: program.createdAt,
    updatedAt: program.updatedAt,
    deletedAt: program.deletedAt,
  };
}

router.get("/programs", requireAuth, async (req, res) => {
  const programDomain = getProgramDomain(req);

  try {
    const rows = await prisma.program.findMany({
      where: {
        programDomain,
        deletedAt: null,
      },
      orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
    });

    if (rows.length > 0) {
      res.json(rows.map(mapProgram));
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch programs";
    if (!message.toLowerCase().includes("program")) {
      res.status(500).json({ error: message });
      return;
    }
  }

  // Fallback when program table is not provisioned yet.
  const list = Object.entries(programs).map(([key, program], index) => ({
    id: key,
    slug: key,
    organizationId: null,
    name: program.displayName,
    shortDescription: `${program.displayName} workspace`,
    longDescription: `${program.displayName} workspace`,
    category: "Operations",
    tags: [],
    status: "live",
    type: "internal",
    origin: "suite-native",
    internalRoute: program.routePrefix,
    externalUrl: null,
    openInNewTab: false,
    logoUrl: null,
    screenshotUrl: null,
    accentColor: null,
    isFeatured: index < 3,
    isPublic: true,
    requiresLogin: false,
    requiresApproval: false,
    launchLabel: "Launch",
    displayOrder: index + 1,
    notes: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
    key,
    routePrefix: program.routePrefix,
  }));
  res.json(list);
});

router.post("/programs", requireAuth, async (req, res) => {
  const input = (req.body || {}) as ProgramInput;
  const programDomain = getProgramDomain(req);

  if (!input.name || !input.name.trim()) {
    res.status(400).json({ error: "Program name is required" });
    return;
  }

  if (!input.shortDescription || !input.shortDescription.trim()) {
    res.status(400).json({ error: "Short description is required" });
    return;
  }

  const type = (input.type || "internal").trim();
  if (type === "internal" && !input.internalRoute) {
    res.status(400).json({ error: "Internal programs require an internalRoute" });
    return;
  }
  if (type === "external" && !input.externalUrl) {
    res.status(400).json({ error: "External programs require an externalUrl" });
    return;
  }

  const slug = (input.slug && input.slug.trim()) || toSlug(input.name);

  try {
    const created = await prisma.program.create({
      data: {
        id: input.id && input.id.trim() ? input.id.trim() : undefined,
        programDomain,
        organizationId: input.organizationId || null,
        slug,
        name: input.name.trim(),
        shortDescription: input.shortDescription.trim(),
        longDescription: input.longDescription || input.shortDescription.trim(),
        category: input.category || "General",
        tags: asStringArray(input.tags),
        status: input.status || "live",
        type,
        origin: input.origin || "suite-native",
        internalRoute: input.internalRoute || null,
        externalUrl: input.externalUrl || null,
        openInNewTab: Boolean(input.openInNewTab),
        logoUrl: input.logoUrl || null,
        screenshotUrl: input.screenshotUrl || null,
        accentColor: input.accentColor || null,
        isFeatured: Boolean(input.isFeatured),
        isPublic: input.isPublic !== false,
        requiresLogin: Boolean(input.requiresLogin),
        requiresApproval: Boolean(input.requiresApproval),
        launchLabel: input.launchLabel || "Launch",
        displayOrder: typeof input.displayOrder === "number" ? input.displayOrder : 999,
        notes: input.notes || "",
      },
    });

    res.status(201).json(mapProgram(created));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create program";
    res.status(400).json({ error: message });
  }
});

router.put("/programs/:id", requireAuth, async (req, res) => {
  const id = getRouteId(req.params.id);
  const input = (req.body || {}) as ProgramInput;
  const programDomain = getProgramDomain(req);

  if (!id) {
    res.status(400).json({ error: "Program id is required" });
    return;
  }

  try {
    const current = await prisma.program.findFirst({
      where: {
        id,
        programDomain,
        deletedAt: null,
      },
    });

    if (!current) {
      res.status(404).json({ error: "Program not found" });
      return;
    }

    const nextName = input.name?.trim() || current.name;
    const nextType = (input.type || current.type).trim();
    const nextInternalRoute = input.internalRoute === undefined ? current.internalRoute : input.internalRoute;
    const nextExternalUrl = input.externalUrl === undefined ? current.externalUrl : input.externalUrl;

    if (nextType === "internal" && !nextInternalRoute) {
      res.status(400).json({ error: "Internal programs require an internalRoute" });
      return;
    }

    if (nextType === "external" && !nextExternalUrl) {
      res.status(400).json({ error: "External programs require an externalUrl" });
      return;
    }

    const updated = await prisma.program.update({
      where: { id },
      data: {
        slug: input.slug?.trim() || (input.name ? toSlug(nextName) : current.slug),
        organizationId: input.organizationId === undefined ? current.organizationId : input.organizationId,
        name: nextName,
        shortDescription: input.shortDescription?.trim() || current.shortDescription,
        longDescription: input.longDescription === undefined ? current.longDescription : input.longDescription,
        category: input.category === undefined ? current.category : input.category,
        tags: input.tags === undefined ? current.tags : asStringArray(input.tags),
        status: input.status === undefined ? current.status : input.status,
        type: nextType,
        origin: input.origin === undefined ? current.origin : input.origin,
        internalRoute: nextInternalRoute || null,
        externalUrl: nextExternalUrl || null,
        openInNewTab: input.openInNewTab === undefined ? current.openInNewTab : Boolean(input.openInNewTab),
        logoUrl: input.logoUrl === undefined ? current.logoUrl : input.logoUrl,
        screenshotUrl: input.screenshotUrl === undefined ? current.screenshotUrl : input.screenshotUrl,
        accentColor: input.accentColor === undefined ? current.accentColor : input.accentColor,
        isFeatured: input.isFeatured === undefined ? current.isFeatured : Boolean(input.isFeatured),
        isPublic: input.isPublic === undefined ? current.isPublic : Boolean(input.isPublic),
        requiresLogin: input.requiresLogin === undefined ? current.requiresLogin : Boolean(input.requiresLogin),
        requiresApproval: input.requiresApproval === undefined ? current.requiresApproval : Boolean(input.requiresApproval),
        launchLabel: input.launchLabel === undefined ? current.launchLabel : input.launchLabel,
        displayOrder: input.displayOrder === undefined ? current.displayOrder : input.displayOrder,
        notes: input.notes === undefined ? current.notes : input.notes,
      },
    });

    res.json(mapProgram(updated));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update program";
    res.status(400).json({ error: message });
  }
});

router.delete("/programs/:id", requireAuth, async (req, res) => {
  const id = getRouteId(req.params.id);
  const programDomain = getProgramDomain(req);

  if (!id) {
    res.status(400).json({ error: "Program id is required" });
    return;
  }

  try {
    const updated = await prisma.program.updateMany({
      where: {
        id,
        programDomain,
        deletedAt: null,
      },
      data: {
        deletedAt: new Date(),
        status: "archived",
      },
    });

    if (updated.count === 0) {
      res.status(404).json({ error: "Program not found" });
      return;
    }

    res.json({ id, deleted: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete program";
    res.status(400).json({ error: message });
  }
});

export { router as programRouter };
