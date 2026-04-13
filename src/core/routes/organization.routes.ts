import express from "express";
import { prisma } from "../db/prisma.js";
import { DEFAULT_ORGANIZATION_ID } from "../config/env.js";
import { requireAuth, tryAttachAuthUser } from "../middleware/auth.middleware.js";
import { hashPassword, getRequestUser, generateTempPassword } from "../auth/auth.service.js";
import { provisionOrgSubscriptions, provisionOrgFromAssignedIds } from "../services/orgProvisioning.js";
import { logger } from "../../logger.js";

const router = express.Router();

function getOrgId(param: string | string[]): string {
  return Array.isArray(param) ? param[0] : param;
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isPlatformAdmin(requestUser: ReturnType<typeof getRequestUser>): boolean {
  if (!requestUser) return false;
  return requestUser.platformRole === "suite_admin" || requestUser.role === "admin";
}

function mapHubRoleToMembershipRole(role: string): "owner" | "admin" | "manager" | "member" | "viewer" {
  switch (role) {
    case "org_admin":
      return "admin";
    case "manager":
      return "manager";
    case "viewer":
      return "viewer";
    case "staff":
      return "member";
    case "super_admin":
      return "admin";
    default:
      return "member";
  }
}

function mapMembershipRoleToHubRole(role: string): "org_admin" | "manager" | "staff" | "viewer" {
  switch (role) {
    case "owner":
    case "admin":
      return "org_admin";
    case "manager":
      return "manager";
    case "viewer":
      return "viewer";
    case "member":
    default:
      return "staff";
  }
}

async function ensureOrgAdminAccess(
  requestUser: ReturnType<typeof getRequestUser>,
  orgId: string,
): Promise<boolean> {
  if (!requestUser) return false;
  if (isPlatformAdmin(requestUser)) return true;

  const membership = await prisma.membership.findFirst({
    where: { userId: requestUser.userId, organizationId: orgId },
  });

  return Boolean(membership && ["owner", "admin"].includes(membership.role));
}

function toDisplayNameFromEmail(email: string): string {
  return email.split("@")[0] || "owner";
}

async function findOrgOwner(orgId: string, ownerEmail: string) {
  const ownerUser = await prisma.user.findFirst({ where: { email: ownerEmail } });
  if (!ownerUser) {
    return { ownerUser: null, membership: null };
  }

  const membership = await prisma.membership.findFirst({
    where: { userId: ownerUser.id, organizationId: orgId },
  });

  return { ownerUser, membership };
}

async function ensureOwnerUserForOrganization(orgId: string, ownerEmail: string) {
  const existing = await findOrgOwner(orgId, ownerEmail);
  if (existing.ownerUser) {
    if (!existing.membership) {
      await prisma.membership.create({
        data: { userId: existing.ownerUser.id, organizationId: orgId, role: "owner" },
      });
    } else if (existing.membership.role !== "owner") {
      await prisma.membership.update({
        where: { id: existing.membership.id },
        data: { role: "owner" },
      });
    }

    return existing.ownerUser;
  }

  const displayName = toDisplayNameFromEmail(ownerEmail);
  const [firstName, ...rest] = displayName.split(" ");
  const created = await prisma.user.create({
    data: {
      email: ownerEmail,
      passwordHash: "",
      role: "uploader",
      platformRole: "user",
      displayName,
      firstName: firstName || "",
      lastName: rest.join(" ") || "",
      organizationId: orgId,
      identitySource: "local",
      mustChangePassword: false,
    },
  });

  await prisma.membership.create({
    data: { userId: created.id, organizationId: orgId, role: "owner" },
  });

  return created;
}

function resolveOwnerPasswordStatus(ownerUser: { passwordHash: string; mustChangePassword: boolean } | null) {
  if (!ownerUser || !ownerUser.passwordHash) return "not_initialized" as const;
  if (ownerUser.mustChangePassword) return "reset_pending" as const;
  return "active" as const;
}

/** Strip any domain suffix from a raw slug value (e.g. "acme.ntlops.com" → "acme"). */
function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/\.ntlops\.com$/, "")
    .replace(/\.nltops\.com$/, "")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildOrgData(body: Record<string, unknown>) {
  const data: Record<string, unknown> = {};
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) || undefined : undefined);

  if (str(body.name) !== undefined) data.name = str(body.name);
  if (str(body.slug) !== undefined) data.slug = sanitizeSlug(str(body.slug)!);
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
// Optionally accepts contactUser: { name, email } to provision the org owner automatically.
// When provided, a temp password is generated and returned once in the response.
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

    // Provision OrganizationProgramSubscription rows for every assigned program
    const programIds = Array.isArray(body.assignedProgramIds)
      ? (body.assignedProgramIds as unknown[]).filter((id): id is string => typeof id === "string" && Boolean(id.trim()))
      : [];
    if (programIds.length > 0) {
      const provResult = await provisionOrgSubscriptions(org.id, programIds);
      logger.info("[orgs/create] subscriptions provisioned", { organizationId: org.id, ...provResult });
    }

    // Optional: provision contact user as org owner
    const contactUser = body.contactUser as { name?: string; email?: string } | undefined;
    if (contactUser && typeof contactUser.email === "string" && contactUser.email.trim()) {
      const email = normalizeEmail(contactUser.email);
      const name = (typeof contactUser.name === "string" ? contactUser.name.trim() : "") || email.split("@")[0];
      const [firstName, ...rest] = name.split(" ");
      let tempPassword: string | undefined;

      let user = await prisma.user.findFirst({ where: { email } });
      if (!user) {
        tempPassword = generateTempPassword();
        const passwordHash = await hashPassword(tempPassword);
        user = await prisma.user.create({
          data: {
            email,
            passwordHash,
            role: "uploader",
            platformRole: "user",
            displayName: name,
            firstName: firstName || "",
            lastName: rest.join(" ") || "",
            organizationId: org.id,
            identitySource: "local",
            mustChangePassword: true,
            passwordSetAt: new Date(),
          },
        });
      }

      // Add as owner membership for this organization.
      const existing = await prisma.membership.findFirst({ where: { userId: user.id, organizationId: org.id } });
      if (!existing) {
        await prisma.membership.create({ data: { userId: user.id, organizationId: org.id, role: "owner" } });
      } else {
        await prisma.membership.update({ where: { id: existing.id }, data: { role: "owner" } });
      }

      res.status(201).json({ ...org, contactUserId: user.id, contactUserEmail: email, tempPassword });
      return;
    }

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

// GET /api/orgs/:orgId/owner-access
// Platform admin-only owner credential status for organization settings.
router.get("/:orgId/owner-access", requireAuth, async (req, res) => {
  const requestUser = getRequestUser(req);
  if (!isPlatformAdmin(requestUser)) {
    res.status(403).json({ error: "Only platform admins can access owner credentials" });
    return;
  }

  const orgId = getOrgId(req.params.orgId);
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) {
    res.status(404).json({ error: "Organization not found" });
    return;
  }

  const ownerEmail = normalizeEmail(org.ownerEmail);
  if (!ownerEmail) {
    res.status(400).json({ error: "Organization owner email is not configured" });
    return;
  }

  const { ownerUser, membership } = await findOrgOwner(org.id, ownerEmail);
  const passwordStatus = resolveOwnerPasswordStatus(ownerUser);

  res.json({
    organizationId: org.id,
    ownerEmail,
    ownerUserId: ownerUser?.id ?? null,
    orgRole: membership?.role ?? "owner",
    platformRole: ownerUser?.platformRole ?? "user",
    passwordStatus,
    mustChangePassword: ownerUser?.mustChangePassword ?? false,
    passwordInitializedAt: ownerUser?.passwordSetAt ?? null,
    temporaryPasswordIssuedAt: ownerUser?.mustChangePassword ? ownerUser?.passwordSetAt ?? null : null,
    initialPasswordAllowed: !ownerUser?.passwordHash,
    resetAllowed: Boolean(ownerUser?.passwordHash),
  });
});

// POST /api/orgs/:orgId/owner-access/initialize-password
// One-time initial password bootstrap for the configured organization owner.
router.post("/:orgId/owner-access/initialize-password", requireAuth, async (req, res) => {
  const requestUser = getRequestUser(req);
  if (!isPlatformAdmin(requestUser)) {
    res.status(403).json({ error: "Only platform admins can initialize owner credentials" });
    return;
  }

  const orgId = getOrgId(req.params.orgId);
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) {
    res.status(404).json({ error: "Organization not found" });
    return;
  }

  const ownerEmail = normalizeEmail(org.ownerEmail);
  if (!ownerEmail) {
    res.status(400).json({ error: "Organization owner email is not configured" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const shouldGenerate = body.generateTempPassword !== false;
  const suppliedPassword = typeof body.newPassword === "string" ? body.newPassword.trim() : "";

  let ownerUser = await ensureOwnerUserForOrganization(org.id, ownerEmail);
  if (ownerUser.passwordHash) {
    res.status(409).json({ error: "Initial password has already been set for this owner account" });
    return;
  }

  const plainPassword = shouldGenerate ? generateTempPassword() : suppliedPassword;
  if (!plainPassword || plainPassword.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const passwordHash = await hashPassword(plainPassword);
  ownerUser = await prisma.user.update({
    where: { id: ownerUser.id },
    data: {
      passwordHash,
      mustChangePassword: true,
      passwordSetAt: new Date(),
    },
  });

  res.json({
    organizationId: org.id,
    ownerUserId: ownerUser.id,
    ownerEmail,
    tempPassword: shouldGenerate ? plainPassword : undefined,
    mustChangePassword: true,
    passwordStatus: resolveOwnerPasswordStatus(ownerUser),
  });
});

// POST /api/orgs/:orgId/owner-access/reset-password
// Generates a new temporary password and requires change on next login.
router.post("/:orgId/owner-access/reset-password", requireAuth, async (req, res) => {
  const requestUser = getRequestUser(req);
  if (!isPlatformAdmin(requestUser)) {
    res.status(403).json({ error: "Only platform admins can reset owner credentials" });
    return;
  }

  const orgId = getOrgId(req.params.orgId);
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) {
    res.status(404).json({ error: "Organization not found" });
    return;
  }

  const ownerEmail = normalizeEmail(org.ownerEmail);
  if (!ownerEmail) {
    res.status(400).json({ error: "Organization owner email is not configured" });
    return;
  }

  const ownerUser = await ensureOwnerUserForOrganization(org.id, ownerEmail);
  if (!ownerUser.passwordHash) {
    res.status(400).json({ error: "Owner password has not been initialized yet" });
    return;
  }

  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);
  const updated = await prisma.user.update({
    where: { id: ownerUser.id },
    data: {
      passwordHash,
      mustChangePassword: true,
      passwordSetAt: new Date(),
    },
  });

  res.json({
    organizationId: org.id,
    ownerUserId: updated.id,
    ownerEmail,
    tempPassword,
    mustChangePassword: true,
    passwordStatus: resolveOwnerPasswordStatus(updated),
  });
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
  const requestUser = getRequestUser(req);
  const orgIdParam = req.params.orgId;
  const orgId = Array.isArray(orgIdParam) ? orgIdParam[0] : orgIdParam;

  if (!orgId) {
    res.status(400).json({ error: "Organization id is required" });
    return;
  }

  const hasAccess = await ensureOrgAdminAccess(requestUser, orgId);
  if (!hasAccess) {
    res.status(403).json({ error: "Only org admins can view organization users" });
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
          mustChangePassword: true,
          passwordSetAt: true,
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
              name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email,
              isActive: user.isActive,
              role: mapMembershipRoleToHubRole(entry.role),
              organizationId: orgId,
              mustChangePassword: user.mustChangePassword,
              temporaryPasswordIssuedAt: user.mustChangePassword ? user.passwordSetAt : null,
              passwordSetAt: user.passwordSetAt,
              accountStatus: !user.isActive
                ? "disabled"
                : user.mustChangePassword
                  ? "password_change_required"
                  : user.passwordSetAt
                    ? "active"
                    : "invited",
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
        mustChangePassword: true,
        passwordSetAt: true,
        role: true,
        organizationId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json(
      users.map((user) => ({
        ...user,
        name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email,
        role: mapMembershipRoleToHubRole(user.role),
        temporaryPasswordIssuedAt: user.mustChangePassword ? user.passwordSetAt : null,
        accountStatus: !user.isActive
          ? "disabled"
          : user.mustChangePassword
            ? "password_change_required"
            : user.passwordSetAt
              ? "active"
              : "invited",
      })),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch organization users";
    res.status(500).json({ error: message });
  }
});

// ─── Org user management ─────────────────────────────────────────────────────

// POST /api/orgs/:orgId/users — create a user and add them to the org
// Always generates a temp password. Returns it once in the response.
router.post("/:orgId/users", requireAuth, async (req, res) => {
  const requestingUser = getRequestUser(req);
  const orgId = getOrgId(req.params.orgId);
  const body = req.body as Record<string, unknown>;

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const firstName = typeof body.firstName === "string" ? body.firstName.trim() : "";
  const lastName = typeof body.lastName === "string" ? body.lastName.trim() : "";
  const fallbackName = typeof body.name === "string" ? body.name.trim() : "";
  const displayName = [firstName, lastName].filter(Boolean).join(" ") || fallbackName || email.split("@")[0] || "User";
  const hubRole = typeof body.role === "string" ? body.role : "staff";
  const role = mapHubRoleToMembershipRole(hubRole);
  const passwordMode = body.passwordMode === "manual" ? "manual" : "auto";
  const manualPassword = typeof body.tempPassword === "string" ? body.tempPassword.trim() : "";

  if (!email) {
    res.status(400).json({ error: "email is required" });
    return;
  }

  const hasAccess = await ensureOrgAdminAccess(requestingUser, orgId);
  if (!hasAccess) {
    res.status(403).json({ error: "Only org admins can create organization users" });
    return;
  }

  if (passwordMode === "manual" && manualPassword.length < 8) {
    res.status(400).json({ error: "Manual temporary password must be at least 8 characters" });
    return;
  }

  try {
    const tempPassword = passwordMode === "manual" ? manualPassword : generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);
    const invitedById = requestingUser?.userId ?? null;

    // Find existing user by email, or create new
    let user = await prisma.user.findFirst({ where: { email } });
    let existingUser = false;
    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          passwordHash,
          role: "uploader",
          platformRole: "user",
          displayName,
          firstName: firstName || "",
          lastName: lastName || "",
          organizationId: orgId,
          identitySource: "local",
          mustChangePassword: true,
          passwordSetAt: new Date(),
        },
      });
    } else {
      existingUser = true;
      const existingMembership = await prisma.membership.findFirst({
        where: { userId: user.id, organizationId: orgId },
      });
      if (existingMembership) {
        res.status(409).json({ error: "User already exists in this organization" });
        return;
      }

      // Existing user: attach to org and rotate to temporary credential for first login
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          mustChangePassword: true,
          passwordSetAt: new Date(),
          firstName: firstName || user.firstName,
          lastName: lastName || user.lastName,
          displayName,
        },
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
      name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.displayName || user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: hubRole,
      organizationId: orgId,
      active: user.isActive,
      assignedProgramIds: Array.isArray(body.assignedProgramIds) ? body.assignedProgramIds : [],
      mustChangePassword: true,
      accountStatus: "password_change_required",
      invitedById,
      temporaryPasswordIssuedAt: user.passwordSetAt,
      passwordSetAt: user.passwordSetAt,
      passwordWasGenerated: passwordMode === "auto",
      existingUser,
      tempPassword: passwordMode === "auto" ? tempPassword : undefined,
      manualTempPassword: passwordMode === "manual" ? tempPassword : undefined,
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

// POST /api/orgs/:orgId/users/:userId/reset-password — org admin resets user password
router.post("/:orgId/users/:userId/reset-password", requireAuth, async (req, res) => {
  const requestingUser = getRequestUser(req);
  if (!requestingUser) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const orgId = getOrgId(req.params.orgId);
  const userId = typeof req.params.userId === "string" ? req.params.userId : "";

  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }

  const hasAccess = await ensureOrgAdminAccess(requestingUser, orgId);
  if (!hasAccess) {
    res.status(403).json({ error: "Only org admins can reset user passwords" });
    return;
  }

  try {
    const membership = await prisma.membership.findFirst({
      where: { userId, organizationId: orgId },
      include: { user: true },
    });

    if (!membership || !membership.user) {
      res.status(404).json({ error: "User not found in this organization" });
      return;
    }

    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);
    const updated = await prisma.user.update({
      where: { id: membership.user.id },
      data: {
        passwordHash,
        mustChangePassword: true,
        passwordSetAt: new Date(),
      },
    });

    res.json({
      userId: updated.id,
      email: updated.email,
      tempPassword,
      mustChangePassword: true,
      accountStatus: "password_change_required",
      temporaryPasswordIssuedAt: updated.passwordSetAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to reset user password";
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
    const isAdmin = requesterMembership?.role === "owner"
      || requesterMembership?.role === "admin"
      || requestingUser.platformRole === "suite_admin"
      || requestingUser.role === "admin";

    if (!isOwnPassword && !isAdmin) {
      res.status(403).json({ error: "Only org admins can set passwords for other users" });
      return;
    }

    const passwordHash = await hashPassword(newPassword);
    // If an admin is resetting another user's password, mark it as temporary
    const isReset = !isOwnPassword;
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash, mustChangePassword: isReset, passwordSetAt: new Date() },
    });

    res.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to set password";
    res.status(500).json({ error: message });
  }
});

// POST /api/orgs/:orgId/provision
// Idempotent backfill — creates/activates OrganizationProgramSubscription rows
// for every program in the org's assignedProgramIds.
// Safe to call multiple times; existing active subscriptions are left untouched.
router.post("/:orgId/provision", requireAuth, async (req, res) => {
  const orgId = getOrgId(req.params.orgId);
  if (!orgId) {
    res.status(400).json({ error: "orgId is required" });
    return;
  }

  try {
    const result = await provisionOrgFromAssignedIds(orgId);
    logger.info("[orgs/provision] complete", { organizationId: orgId, ...result });
    res.json({ success: true, organizationId: orgId, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Provisioning failed";
    logger.error("[orgs/provision] error", { organizationId: orgId, error: message });
    res.status(500).json({ error: message });
  }
});

// ─── Org workspace bootstrap ─────────────────────────────────────────────────
//
// GET /api/orgs/bootstrap
//   Returns full org context for an authenticated Suite workspace session —
//   organization record, branding, active programs (from subscriptions), and
//   optionally the current user's membership.
//
//   Org is resolved from (in priority order):
//     1. ?slug= query param
//     2. ?subdomain= query param
//
//   Authentication is optional — unauthenticated requests still get org/branding
//   data, but `membership` will be null.
//
// NOTE: This used to live at /api/portal/bootstrap. The /api/portal/bootstrap
//       path is preserved as a 301 redirect alias in app.ts for backwards compat.
// LEGACY NAME NOTE: "portal/bootstrap" is not a core architecture concept anymore;
//                   /api/orgs/bootstrap is the canonical route name.

type SubscriptionRow = { programId: string; status: string };

const prismaWithSubs = prisma as typeof prisma & {
  organizationProgramSubscription: {
    findMany: (args: Record<string, unknown>) => Promise<SubscriptionRow[]>;
  };
};

router.get("/bootstrap", async (req, res) => {
  // Optional auth — attach user if valid token present but don't 401 without one
  tryAttachAuthUser(req);
  const requestUser = getRequestUser(req);

  const querySlug = typeof req.query.slug === "string" ? req.query.slug.trim() : "";
  const querySubdomain = typeof req.query.subdomain === "string" ? req.query.subdomain.trim() : "";

  let org: Awaited<ReturnType<typeof prisma.organization.findFirst>> | null = null;

  if (querySlug) {
    org = await prisma.organization.findFirst({ where: { slug: querySlug } });
  } else if (querySubdomain) {
    org = await prisma.organization.findFirst({ where: { subdomain: querySubdomain } });
    if (!org) {
      org = await prisma.organization.findFirst({ where: { slug: querySubdomain } });
    }
  }

  if (!org) {
    res.status(404).json({ error: "Organization not found", code: "org_not_found" });
    return;
  }

  // ── Active subscriptions ──────────────────────────────────────────────────
  const subscriptions = await prismaWithSubs.organizationProgramSubscription.findMany({
    where: {
      organizationId: org.id,
      status: { in: ["active", "trialing"] },
    } as Record<string, unknown>,
  });

  let activeProgramIds = subscriptions.map((s) => s.programId);

  // First-run: auto-provision from assignedProgramIds if no subscriptions exist
  if (activeProgramIds.length === 0) {
    const rawIds = Array.isArray(org.assignedProgramIds) ? (org.assignedProgramIds as string[]) : [];
    if (rawIds.length > 0) {
      logger.info("[orgs/bootstrap] no subscriptions — auto-provisioning", {
        organizationId: org.id,
        programCount: rawIds.length,
      });
      try {
        await provisionOrgFromAssignedIds(org.id);
        const freshSubs = await prismaWithSubs.organizationProgramSubscription.findMany({
          where: {
            organizationId: org.id,
            status: { in: ["active", "trialing"] },
          } as Record<string, unknown>,
        });
        activeProgramIds = freshSubs.map((s) => s.programId);
      } catch (err) {
        logger.error("[orgs/bootstrap] auto-provisioning failed", {
          organizationId: org.id,
          error: err instanceof Error ? err.message : String(err),
        });
        activeProgramIds = rawIds;
      }
    }
  }

  // ── Enabled programs ──────────────────────────────────────────────────────
  let enabledPrograms: Awaited<ReturnType<typeof prisma.program.findMany>> = [];
  if (activeProgramIds.length > 0) {
    enabledPrograms = await prisma.program.findMany({
      where: {
        id: { in: activeProgramIds },
        deletedAt: null,
      } as Record<string, unknown>,
      orderBy: { displayOrder: "asc" },
    });
  }

  // ── Membership for authenticated user ─────────────────────────────────────
  let membership: {
    orgId: string;
    userId: string;
    role: string;
    active: boolean;
    email: string;
    name: string;
  } | null = null;

  if (requestUser?.userId) {
    const membershipRow = await prisma.membership.findFirst({
      where: { userId: requestUser.userId, organizationId: org.id },
    });

    if (membershipRow) {
      const userRow = await prisma.user.findUnique({
        where: { id: membershipRow.userId },
        select: { id: true, email: true, displayName: true, firstName: true, lastName: true },
      });

      if (userRow) {
        const displayName = userRow.displayName || `${userRow.firstName} ${userRow.lastName}`.trim() || userRow.email;
        membership = {
          orgId: org.id,
          userId: membershipRow.userId,
          role: membershipRow.role,
          active: true,
          email: userRow.email,
          name: displayName,
        };
      }
    }
  }

  // ── Branding ──────────────────────────────────────────────────────────────
  const branding = {
    primaryColor: org.primaryColor || "217 80% 56%",
    secondaryColor: "220 70% 40%",
    accentColor: org.accentColor || "191 85% 47%",
    backgroundColor: "#0f172a",
    backgroundStartColor: "#0f172a",
    backgroundEndColor: "#1d4ed8",
    bannerStartColor: "#1e293b",
    bannerEndColor: "#0ea5e9",
    gradientAngle: 135,
    fontFamily: "inter",
  };

  logger.info("[orgs/bootstrap] served", {
    organizationId: org.id,
    slug: org.slug,
    programCount: enabledPrograms.length,
    authenticated: Boolean(requestUser),
    hasMembership: Boolean(membership),
  });

  res.json({
    organization: {
      ...org,
      assignedProgramIds: activeProgramIds,
    },
    branding,
    membership,
    enabledModules: [],
    enabledPrograms,
    orgStatus: {
      status: org.status,
      isPending: org.status === "pending",
      isActive: org.isActive && org.status === "active",
      isSuspended: org.status === "suspended",
    },
  });
});

export { router as organizationRouter };
