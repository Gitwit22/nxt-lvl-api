import express from "express";
import { prisma } from "./core/db/prisma.js";
import {
  hashPassword,
  verifyPassword,
  signToken,
  getRequestUser,
} from "./core/auth/auth.service.js";
import { requireAuth, requireRole, tryAttachAuthUser } from "./core/middleware/auth.middleware.js";
import { CURRENT_PROGRAM_DOMAIN, PLATFORM_SETUP_TOKEN } from "./core/config/env.js";
import { logger } from "./logger.js";
import { getDefaultTenantScope, getTenantScopeForUser } from "./tenant.js";
import { resolveProgramKey } from "./core/middleware/partition.middleware.js";
import { provisionUserProgramAccessFromOrgSubscriptions } from "./core/services/orgProvisioning.js";

const router = express.Router();

type AuthUserRecord = {
  id: string;
  email: string;
  passwordHash: string;
  role: string;
  platformRole?: string | null;
  displayName: string;
  organizationId?: string | null;
  organizationName?: string | null;
  identitySource?: string | null;
  platformUserId?: string | null;
  mustChangePassword?: boolean | null;
};

const prismaUser = prisma as typeof prisma & {
  user: {
    findUnique: (args: { where: { email?: string; id?: string } }) => Promise<AuthUserRecord | null>;
    count: () => Promise<number>;
    update: (args: {
      where: { id: string };
      data: {
        passwordHash?: string;
        mustChangePassword?: boolean;
        passwordSetAt?: Date | null;
      };
    }) => Promise<AuthUserRecord>;
    create: (args: {
      data: {
        organizationId: string;
        email: string;
        passwordHash: string;
        role: string;
        platformRole?: string;
        displayName: string;
        identitySource?: string;
      };
    }) => Promise<AuthUserRecord>;
  };
};

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function slugifyOrganizationName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "organization";
}

async function generateUniqueOrganizationSlug(name: string): Promise<string> {
  const baseSlug = slugifyOrganizationName(name);
  let candidate = baseSlug;
  let suffix = 1;

  while (true) {
    const existing = await prisma.organization.findUnique({ where: { slug: candidate } });
    if (!existing) return candidate;
    suffix += 1;
    candidate = `${baseSlug}-${suffix}`;
  }
}

/**
 * Derive AppInitState for the response.
 * - "not_initialized" : no users exist at all
 * - "no_org"          : user exists but has no org assignment
 * - "ready"           : user has org context
 */
function resolveAppInitState(user: AuthUserRecord, hasMemberships = false): "not_initialized" | "no_org" | "ready" {
  if (!user.organizationId && !hasMemberships) return "no_org";
  return "ready";
}

/** Build the safe user payload included in API responses. */
function buildUserPayload(user: AuthUserRecord, organizationId: string, programDomain: string) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    platformRole: (user.platformRole ?? "user") as "suite_admin" | "user",
    displayName: user.displayName,
    organizationId,
    organizationName: user.organizationName ?? undefined,
    programDomain,
    identitySource: (user.identitySource ?? "local") as "platform" | "local",
    hasPassword: Boolean(user.passwordHash && user.passwordHash.length > 0),
    mustChangePassword: user.mustChangePassword ?? false,
  };
}

/** Query the Membership table and return orgMemberships for a user. */
async function fetchOrgMemberships(userId: string) {
  try {
    const memberships = await prisma.membership.findMany({
      where: { userId },
      include: { organization: { select: { id: true, name: true, slug: true } } },
    });
    return memberships.map((m) => ({
      orgId: m.organizationId,
      orgName: (m.organization as { name: string } | null)?.name ?? "Organization",
      role: m.role,
      active: true,
    }));
  } catch {
    return [];
  }
}

async function resolveTenantScopeForProgram(
  user: AuthUserRecord,
  programDomain: string,
): Promise<{ organizationId: string; programDomain: string }> {
  const fallback = getTenantScopeForUser(user);

  try {
    if (user.organizationId) {
      const primarySubscription = await prisma.organizationProgramSubscription.findUnique({
        where: {
          organizationId_programId: {
            organizationId: user.organizationId,
            programId: programDomain,
          },
        },
        select: { status: true },
      });

      if (primarySubscription && (primarySubscription.status === "active" || primarySubscription.status === "trialing")) {
        return { organizationId: user.organizationId, programDomain };
      }
    }

    const memberships = await prisma.membership.findMany({
      where: { userId: user.id },
      select: { organizationId: true },
    });

    if (memberships.length > 0) {
      const membershipOrgIds = memberships.map((membership) => membership.organizationId);
      const subscribedMembership = await prisma.organizationProgramSubscription.findFirst({
        where: {
          organizationId: { in: membershipOrgIds },
          programId: programDomain,
          status: { in: ["active", "trialing"] },
        },
        select: { organizationId: true },
      });

      if (subscribedMembership?.organizationId) {
        return { organizationId: subscribedMembership.organizationId, programDomain };
      }
    }
  } catch (error) {
    logger.warn("[auth] failed to resolve tenant scope for program", {
      userId: user.id,
      programDomain,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    organizationId: fallback.organizationId,
    programDomain,
  };
}

function resolveAuthProgramDomain(req: express.Request): string {
  const headerValue =
    typeof req.headers["x-app-partition"] === "string"
      ? req.headers["x-app-partition"]
      : undefined;

  const resolved = resolveProgramKey(headerValue);
  return resolved || CURRENT_PROGRAM_DOMAIN;
}

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const programDomain = resolveAuthProgramDomain(req);

  const body = req.body as Record<string, unknown>;
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  const user = await prismaUser.user.findUnique({ where: { email } });
  if (!user) {
    // Constant-time comparison even on miss — avoids user enumeration
    await bcryptFakeCompare();
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const userIdentitySource = (user as AuthUserRecord).identitySource ?? null;

  // Platform-linked users have no local password — deny password login at constant time
  if (userIdentitySource === "platform" && !user.passwordHash) {
    await bcryptFakeCompare();
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const tenantScope = await resolveTenantScopeForProgram(user, programDomain);
  const orgMemberships = await fetchOrgMemberships(user.id);
  const appInitState = resolveAppInitState(user, orgMemberships.length > 0);
  const token = signToken({
    userId: user.id,
    email: user.email,
    role: user.role,
    platformRole: (user as AuthUserRecord).platformRole ?? "user",
    organizationId: tenantScope.organizationId,
    programDomain,
  });
  logger.info("User logged in", { userId: user.id, role: user.role, organizationId: tenantScope.organizationId, programDomain });

  // Backward/forward compatibility: different frontends may read different token keys.
  res.setHeader("Authorization", `Bearer ${token}`);
  const secureCookie = process.env.NODE_ENV === "production";
  res.cookie("accessToken", token, {
    httpOnly: true,
    secure: secureCookie,
    sameSite: secureCookie ? "none" : "lax",
    maxAge: 8 * 60 * 60 * 1000,
    path: "/",
  });
  res.cookie("token", token, {
    httpOnly: true,
    secure: secureCookie,
    sameSite: secureCookie ? "none" : "lax",
    maxAge: 8 * 60 * 60 * 1000,
    path: "/",
  });

  res.json({
    token,
    accessToken: token,
    authToken: token,
    auth: { token },
    data: { token },
    user: {
      ...buildUserPayload(user, tenantScope.organizationId, programDomain),
      orgMemberships,
    },
    appInitialized: appInitState === "ready",
    appInitState,
  });
});

function buildUserPayloadFromToken(payload: {
  userId: string;
  email: string;
  role: string;
  platformRole?: string;
  organizationId: string;
  programDomain: string;
}) {
  return {
    id: payload.userId,
    email: payload.email,
    role: payload.role,
    platformRole: (payload.platformRole ?? "user") as "suite_admin" | "user",
    displayName: "",
    organizationId: payload.organizationId,
    programDomain: payload.programDomain,
  };
}

async function handleRefresh(req: express.Request, res: express.Response): Promise<void> {
  if (!tryAttachAuthUser(req)) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const payload = getRequestUser(req);
  if (!payload) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const user = await prismaUser.user.findUnique({ where: { id: payload.userId } });
  const token = signToken({
    userId: payload.userId,
    email: payload.email,
    role: payload.role,
    platformRole: (user as AuthUserRecord | null)?.platformRole ?? payload.platformRole ?? "user",
    organizationId: payload.organizationId,
    programDomain: payload.programDomain,
  });

  const secureCookie = process.env.NODE_ENV === "production";
  res.cookie("accessToken", token, {
    httpOnly: true,
    secure: secureCookie,
    sameSite: secureCookie ? "none" : "lax",
    maxAge: 8 * 60 * 60 * 1000,
    path: "/",
  });

  const appInitState = user
    ? resolveAppInitState(user)
    : payload.organizationId ? "ready" : "no_org";

  res.json({
    token,
    accessToken: token,
    authToken: token,
    auth: { token },
    data: { token },
    user: user ? buildUserPayload(user, payload.organizationId, payload.programDomain) : buildUserPayloadFromToken(payload),
    appInitialized: appInitState === "ready",
    appInitState,
  });
}

router.get("/refresh", (req, res) => {
  void handleRefresh(req, res);
});

router.post("/refresh", (req, res) => {
  void handleRefresh(req, res);
});

// POST /api/auth/logout
// Clears auth cookies so refresh/session restoration cannot silently re-authenticate.
router.post("/logout", (_req, res) => {
  const secureCookie = process.env.NODE_ENV === "production";
  const cookieOptions = {
    httpOnly: true,
    secure: secureCookie,
    sameSite: (secureCookie ? "none" : "lax") as "none" | "lax",
    path: "/",
  };

  res.clearCookie("accessToken", cookieOptions);
  res.clearCookie("token", cookieOptions);
  res.clearCookie("authToken", cookieOptions);
  res.clearCookie("jwt", cookieOptions);
  res.clearCookie("session", cookieOptions);

  res.status(204).send();
});

// POST /api/auth/set-password
// For accounts provisioned without a local password (e.g. platform-linked or admin-invited).
// Does NOT require a current password — only requires the account to have no existing password hash.
router.post("/set-password", requireAuth, async (req, res) => {
  const payload = getRequestUser(req);
  if (!payload) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

  if (!newPassword) {
    res.status(400).json({ error: "New password is required" });
    return;
  }

  if (newPassword.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const user = await prismaUser.user.findUnique({ where: { id: payload.userId } });
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (user.passwordHash && user.passwordHash.length > 0) {
    res.status(400).json({ error: "Account already has a password. Use change-password instead." });
    return;
  }

  const nextHash = await hashPassword(newPassword);
  await prismaUser.user.update({
    where: { id: user.id },
    data: { passwordHash: nextHash, mustChangePassword: false, passwordSetAt: new Date() },
  });

  res.status(204).send();
});

// POST /api/auth/complete-force-reset
// For users who logged in with a temp password and must set a new one.
// Only callable when mustChangePassword === true. No current password required.
router.post("/complete-force-reset", requireAuth, async (req, res) => {
  const payload = getRequestUser(req);
  if (!payload) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

  if (!newPassword) {
    res.status(400).json({ error: "New password is required" });
    return;
  }
  if (newPassword.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const user = await prismaUser.user.findUnique({ where: { id: payload.userId } });
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (!(user as AuthUserRecord).mustChangePassword) {
    res.status(400).json({ error: "No forced password reset is pending for this account." });
    return;
  }

  const nextHash = await hashPassword(newPassword);
  await prismaUser.user.update({
    where: { id: user.id },
    data: { passwordHash: nextHash, mustChangePassword: false, passwordSetAt: new Date() },
  });

  res.status(204).send();
});

// POST /api/auth/change-password
// Authenticated users can rotate their own local password.
router.post("/change-password", requireAuth, async (req, res) => {
  const payload = getRequestUser(req);
  if (!payload) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: "Current password and new password are required" });
    return;
  }

  if (newPassword.length < 8) {
    res.status(400).json({ error: "New password must be at least 8 characters" });
    return;
  }

  const user = await prismaUser.user.findUnique({ where: { id: payload.userId } });
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (!user.passwordHash) {
    res.status(400).json({ error: "This account does not support local password changes" });
    return;
  }

  const valid = await verifyPassword(currentPassword, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Current password is incorrect" });
    return;
  }

  const nextHash = await hashPassword(newPassword);
  await prismaUser.user.update({
    where: { id: user.id },
    data: { passwordHash: nextHash, mustChangePassword: false, passwordSetAt: new Date() },
  });

  res.status(204).send();
});

// OPTIONS /api/auth/organizer/signup - CORS preflight
router.options("/organizer/signup", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", req.get("Origin") || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.sendStatus(204);
});

// POST /api/auth/organizer/signup
// Public self-service organizer registration that creates an organization,
// owner user, org membership, and returns an authenticated session token.
router.post("/organizer/signup", async (req, res) => {
  const programDomain = resolveAuthProgramDomain(req);
  const body = req.body as Record<string, unknown>;

  const orgName = typeof body.orgName === "string" ? body.orgName.trim() : "";
  const contactName = typeof body.contactName === "string" ? body.contactName.trim() : "";
  const contactEmail = normalizeEmail(body.contactEmail);
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const website = typeof body.website === "string" ? body.website.trim() : "";
  const businessType = typeof body.businessType === "string" ? body.businessType.trim() : "";
  const bio = typeof body.bio === "string" ? body.bio.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!orgName || !contactName || !contactEmail || !phone || !password) {
    res.status(400).json({
      error: "Organization name, contact name, contact email, phone, and password are required",
    });
    return;
  }

  if (password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const existingUser = await prisma.user.findUnique({ where: { email: contactEmail } });
  if (existingUser) {
    res.status(409).json({ error: "A user with that email already exists" });
    return;
  }

  const slug = await generateUniqueOrganizationSlug(orgName);
  const passwordHash = await hashPassword(password);

  const result = await prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: {
        name: orgName,
        slug,
        ownerEmail: contactEmail,
        contactEmail,
        phoneNumber: phone || undefined,
        industryType: businessType || undefined,
        notes: bio || undefined,
        planType: "starter",
        status: "active",
        isActive: true,
      },
    });

    const user = await tx.user.create({
      data: {
        organizationId: organization.id,
        email: contactEmail,
        passwordHash,
        role: "uploader",
        platformRole: "user",
        displayName: contactName,
        identitySource: "local",
      },
    });

    await tx.membership.create({
      data: {
        organizationId: organization.id,
        userId: user.id,
        role: "owner",
      },
    });

    return { organization, user };
  });

  try {
    const accessResult = await provisionUserProgramAccessFromOrgSubscriptions(
      result.organization.id,
      result.user.id,
    );
    logger.info("[auth/organizer-signup] user program access provisioned", {
      userId: result.user.id,
      organizationId: result.organization.id,
      granted: accessResult.granted,
    });
  } catch (error) {
    logger.warn("[auth/organizer-signup] user program access provisioning failed", {
      userId: result.user.id,
      organizationId: result.organization.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const token = signToken({
    userId: result.user.id,
    email: result.user.email,
    role: result.user.role,
    platformRole: result.user.platformRole ?? "user",
    organizationId: result.organization.id,
    programDomain,
  });

  const secureCookie = process.env.NODE_ENV === "production";
  res.cookie("accessToken", token, {
    httpOnly: true,
    secure: secureCookie,
    sameSite: secureCookie ? "none" : "lax",
    maxAge: 8 * 60 * 60 * 1000,
    path: "/",
  });
  res.cookie("token", token, {
    httpOnly: true,
    secure: secureCookie,
    sameSite: secureCookie ? "none" : "lax",
    maxAge: 8 * 60 * 60 * 1000,
    path: "/",
  });

  logger.info("Organizer self-signup completed", {
    userId: result.user.id,
    organizationId: result.organization.id,
    programDomain,
  });

  res.status(201).json({
    token,
    accessToken: token,
    authToken: token,
    auth: { token },
    data: { token },
    user: {
      ...buildUserPayload(result.user, result.organization.id, programDomain),
      organizationName: result.organization.name,
      orgMemberships: [
        {
          orgId: result.organization.id,
          orgName: result.organization.name,
          role: "owner",
          active: true,
        },
      ],
    },
    appInitialized: true,
    appInitState: "ready",
  });
});

// POST /api/auth/register
// - First user can always self-register (bootstrapping).
// - All other users require admin JWT or PLATFORM_SETUP_TOKEN.
router.post(
  "/register",
  (req, res, next) => {
    const body = req.body as Record<string, unknown>;
    const providedToken = typeof body.platformSetupToken === "string"
      ? body.platformSetupToken.trim()
      : typeof body.setupToken === "string" ? body.setupToken.trim() : "";
    if (PLATFORM_SETUP_TOKEN && providedToken && providedToken === PLATFORM_SETUP_TOKEN) {
      return next(); // valid setup token bypass
    }
    void prismaUser.user
      .count()
      .then((count) => {
        if (count === 0) return next(); // allow first user
        requireAuth(req, res, () => requireRole("admin")(req, res, next));
      })
      .catch(next);
  },
  async (req, res) => {
    const programDomain = resolveAuthProgramDomain(req);
    const body = req.body as Record<string, unknown>;
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const displayName =
      typeof body.displayName === "string" ? body.displayName.trim() : "";
    const role =
      typeof body.role === "string" &&
      ["admin", "reviewer", "uploader"].includes(body.role)
        ? body.role
        : "uploader";

    if (!email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }

    const existing = await prismaUser.user.findUnique({ where: { email } });
    if (existing) {
      res.status(409).json({ error: "A user with that email already exists" });
      return;
    }

    const passwordHash = await hashPassword(password);
    const tenantScope = getRequestUser(req)
      ? getTenantScopeForUser(getRequestUser(req))
      : getDefaultTenantScope();
    const user = await prismaUser.user.create({
      data: {
        organizationId: tenantScope.organizationId,
        email,
        passwordHash,
        role,
        displayName,
        identitySource: "local",
      },
    });

    try {
      const accessResult = await provisionUserProgramAccessFromOrgSubscriptions(
        tenantScope.organizationId,
        user.id,
      );
      logger.info("[auth/register] user program access provisioned", {
        userId: user.id,
        organizationId: tenantScope.organizationId,
        granted: accessResult.granted,
      });
    } catch (error) {
      logger.warn("[auth/register] user program access provisioning failed", {
        userId: user.id,
        organizationId: tenantScope.organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logger.info("User registered", {
      userId: user.id,
      role: user.role,
      organizationId: tenantScope.organizationId,
      programDomain,
    });

    res.status(201).json({
      user: buildUserPayload(user, tenantScope.organizationId, programDomain),
    });
  },
);

// GET /api/auth/me
// Returns the current user with full org context and app-init state.
// Frontend calls this on mount to validate the stored token and refresh context.
router.get("/me", requireAuth, async (req, res) => {
  const payload = getRequestUser(req);
  if (!payload) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const user = await prismaUser.user.findUnique({ where: { id: payload.userId } });
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const tenantScope = await resolveTenantScopeForProgram(user, payload.programDomain);
  const orgMemberships = await fetchOrgMemberships(user.id);
  const appInitState = resolveAppInitState(user, orgMemberships.length > 0);
  res.json({
    user: {
      ...buildUserPayload(user, tenantScope.organizationId, payload.programDomain),
      orgMemberships,
    },
    appInitialized: appInitState === "ready",
    appInitState,
  });
});

// Timing-safe dummy hash comparison to prevent user enumeration on login miss
async function bcryptFakeCompare(): Promise<void> {
  await verifyPassword(
    "dummy",
    "$2a$12$invalidhashpaddingtomakeittimeconstant00000000000000000",
  );
}

export { router as authRouter };
