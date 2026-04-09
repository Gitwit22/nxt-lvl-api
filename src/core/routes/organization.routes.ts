import express from "express";
import { prisma } from "../db/prisma.js";
import { DEFAULT_ORGANIZATION_ID } from "../config/env.js";
import { requireAuth } from "../middleware/auth.middleware.js";

const router = express.Router();

function getOrgId(param: string | string[]): string {
  return Array.isArray(param) ? param[0] : param;
}

function buildOrgData(body: Record<string, unknown>) {
  const data: Record<string, unknown> = {};
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) || undefined : undefined);

  if (str(body.name) !== undefined) data.name = str(body.name);
  if (str(body.slug) !== undefined) data.slug = str(body.slug);
  if ("subdomain" in body) data.subdomain = str(body.subdomain) ?? null;
  if ("contactEmail" in body) data.contactEmail = str(body.contactEmail) ?? null;
  if ("ownerEmail" in body) data.ownerEmail = str(body.ownerEmail) ?? null;
  if ("supportEmail" in body) data.supportEmail = str(body.supportEmail) ?? null;
  if ("phoneNumber" in body) data.phoneNumber = str(body.phoneNumber) ?? null;
  if ("industryType" in body) data.industryType = str(body.industryType) ?? null;
  if ("notes" in body) data.notes = str(body.notes) ?? null;
  if ("logoUrl" in body) data.logoUrl = str(body.logoUrl) ?? null;
  if ("bannerUrl" in body) data.bannerUrl = str(body.bannerUrl) ?? null;
  if ("primaryColor" in body) data.primaryColor = str(body.primaryColor) ?? null;
  if ("accentColor" in body) data.accentColor = str(body.accentColor) ?? null;
  if ("planType" in body) data.planType = str(body.planType) ?? "starter";
  if ("status" in body) {
    data.status = str(body.status) ?? "active";
    data.isActive = data.status !== "suspended" && data.status !== "inactive";
  }
  if ("seatLimit" in body) data.seatLimit = num(body.seatLimit) ?? 25;
  if ("trialEndsAt" in body) {
    const v = body.trialEndsAt;
    data.trialEndsAt = v ? new Date(v as string) : null;
  }
  if ("assignedBundleIds" in body) data.assignedBundleIds = Array.isArray(body.assignedBundleIds) ? body.assignedBundleIds : [];
  if ("assignedProgramIds" in body) data.assignedProgramIds = Array.isArray(body.assignedProgramIds) ? body.assignedProgramIds : [];
  return data;
}

// List all organizations
router.get("/", requireAuth, async (_req, res) => {
  try {
    const rows = await prisma.organization.findMany({
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    if (rows.length > 0) {
      res.json(rows);
      return;
    }
  } catch {
    // fallthrough
  }
  res.json([{ id: DEFAULT_ORGANIZATION_ID, name: "Default Organization", slug: DEFAULT_ORGANIZATION_ID, isActive: true, status: "active", planType: "starter", seatLimit: 25, assignedBundleIds: [], assignedProgramIds: [] }]);
});

// Create organization
router.post("/", requireAuth, async (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (!body.name || typeof body.name !== "string") {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (!body.slug || typeof body.slug !== "string") {
    res.status(400).json({ error: "slug is required" });
    return;
  }
  try {
    const data = buildOrgData(body);
    const org = await prisma.organization.create({ data: data as Parameters<typeof prisma.organization.create>[0]["data"] });
    res.status(201).json(org);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create organization";
    if (message.includes("Unique constraint")) {
      res.status(409).json({ error: "An organization with that slug already exists" });
      return;
    }
    res.status(500).json({ error: message });
  }
});

// Update organization
router.put("/:orgId", requireAuth, async (req, res) => {
  const orgId = getOrgId(req.params.orgId);
  const body = req.body as Record<string, unknown>;
  try {
    const existing = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!existing) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const data = buildOrgData(body);
    const org = await prisma.organization.update({ where: { id: orgId }, data: data as Parameters<typeof prisma.organization.update>[0]["data"] });
    res.json(org);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update organization";
    res.status(500).json({ error: message });
  }
});

router.get("/:orgId/users", requireAuth, async (req, res) => {
  const orgIdParam = req.params.orgId;
  const orgId = Array.isArray(orgIdParam) ? orgIdParam[0] : orgIdParam;

  if (!orgId) {
    res.status(400).json({ error: "Organization id is required" });
    return;
  }

  try {
    const members = await prisma.membership.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: "asc" },
      select: {
        userId: true,
        role: true,
      },
    });

    if (members.length > 0) {
      const userIds = members.map((entry) => entry.userId);
      const users = await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      const userById = new Map(users.map((u) => [u.id, u]));
      res.json(
        members
          .map((entry) => {
            const user = userById.get(entry.userId);
            if (!user) return null;
            return {
              id: user.id,
              email: user.email,
              firstName: user.firstName,
              lastName: user.lastName,
              isActive: user.isActive,
              role: entry.role,
              organizationId: orgId,
              createdAt: user.createdAt,
              updatedAt: user.updatedAt,
            };
          })
          .filter((row): row is NonNullable<typeof row> => row !== null),
      );
      return;
    }

    // Fallback for datasets where membership rows are not populated.
    const users = await prisma.user.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        isActive: true,
        role: true,
        organizationId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json(users);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch organization users";
    res.status(500).json({ error: message });
  }
});

export { router as organizationRouter };
