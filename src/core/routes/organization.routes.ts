import express from "express";
import { prisma } from "../db/prisma.js";
import { DEFAULT_ORGANIZATION_ID } from "../config/env.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { hashPassword, getRequestUser } from "../auth/auth.service.js";

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

// ─── Org user management ─────────────────────────────────────────────────────

// POST /api/orgs/:orgId/users — create a user and add them to the org
router.post("/:orgId/users", requireAuth, async (req, res) => {
  const orgId = getOrgId(req.params.orgId);
  const body = req.body as Record<string, unknown>;

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const role = typeof body.role === "string" ? body.role : "staff";
  const initialPassword = typeof body.initialPassword === "string" ? body.initialPassword.trim() : "";

  if (!email) {
    res.status(400).json({ error: "email is required" });
    return;
  }

  if (initialPassword && initialPassword.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  try {
    const passwordHash = initialPassword ? await hashPassword(initialPassword) : "";
    const [firstName, ...rest] = name.split(" ");
    const lastName = rest.join(" ");

    // Find existing user by email, or create new
    let user = await prisma.user.findFirst({ where: { email } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          passwordHash,
          role: "uploader",
          displayName: name || email.split("@")[0],
          firstName: firstName || "",
          lastName: lastName || "",
          organizationId: orgId,
          identitySource: "local",
        },
      });
    } else if (initialPassword) {
      // Update password hash if one was provided
      user = await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash },
      });
    }

    // Upsert membership
    const existing = await prisma.membership.findFirst({
      where: { userId: user.id, organizationId: orgId },
    });

    if (!existing) {
      await prisma.membership.create({
        data: { userId: user.id, organizationId: orgId, role },
      });
    } else {
      await prisma.membership.update({
        where: { id: existing.id },
        data: { role },
      });
    }

    res.status(201).json({
      id: user.id,
      email: user.email,
      name: user.displayName,
      firstName: user.firstName,
      lastName: user.lastName,
      role,
      organizationId: orgId,
      active: user.isActive,
      assignedProgramIds: Array.isArray(body.assignedProgramIds) ? body.assignedProgramIds : [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create user";
    res.status(500).json({ error: message });
  }
});

// PUT /api/orgs/:orgId/users/:userId — update a user's role or program access
router.put("/:orgId/users/:userId", requireAuth, async (req, res) => {
  const orgId = getOrgId(req.params.orgId);
  const userId = typeof req.params.userId === "string" ? req.params.userId : "";
  const body = req.body as Record<string, unknown>;

  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }

  try {
    const membership = await prisma.membership.findFirst({
      where: { userId, organizationId: orgId },
    });

    if (!membership) {
      res.status(404).json({ error: "User not found in this organization" });
      return;
    }

    const updates: Record<string, unknown> = {};
    if (typeof body.role === "string") updates.role = body.role;

    if (Object.keys(updates).length > 0) {
      await prisma.membership.update({ where: { id: membership.id }, data: updates });
    }

    // Update user display info if provided
    const userUpdates: Record<string, unknown> = {};
    if (typeof body.name === "string") {
      userUpdates.displayName = body.name.trim();
      const [firstName, ...rest] = body.name.trim().split(" ");
      userUpdates.firstName = firstName || "";
      userUpdates.lastName = rest.join(" ") || "";
    }
    if (typeof body.isActive === "boolean") userUpdates.isActive = body.isActive;

    if (Object.keys(userUpdates).length > 0) {
      await prisma.user.update({ where: { id: userId }, data: userUpdates });
    }

    res.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update user";
    res.status(500).json({ error: message });
  }
});

// POST /api/orgs/:orgId/users/:userId/set-password — org admin sets password for a user
router.post("/:orgId/users/:userId/set-password", requireAuth, async (req, res) => {
  const requestingUser = getRequestUser(req);
  if (!requestingUser) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const orgId = getOrgId(req.params.orgId);
  const userId = typeof req.params.userId === "string" ? req.params.userId : "";
  const body = req.body as Record<string, unknown>;
  const newPassword = typeof body.newPassword === "string" ? body.newPassword.trim() : "";

  if (!newPassword) {
    res.status(400).json({ error: "newPassword is required" });
    return;
  }
  if (newPassword.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  try {
    // Verify the requesting user is a member of this org with admin role
    const requesterMembership = await prisma.membership.findFirst({
      where: { userId: requestingUser.userId, organizationId: orgId },
    });

    const isOwnPassword = requestingUser.userId === userId;
    const isAdmin = requesterMembership?.role === "org_admin" || requesterMembership?.role === "super_admin"
      || requestingUser.role === "admin";

    if (!isOwnPassword && !isAdmin) {
      res.status(403).json({ error: "Only org admins can set passwords for other users" });
      return;
    }

    const passwordHash = await hashPassword(newPassword);
    await prisma.user.update({ where: { id: userId }, data: { passwordHash } });

    res.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to set password";
    res.status(500).json({ error: message });
  }
});

export { router as organizationRouter };
