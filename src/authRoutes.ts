import jwt from "jsonwebtoken";
import express from "express";
import { prisma } from "./core/db/prisma.js";
import {
  hashPassword,
  verifyPassword,
  signToken,
  getRequestUser,
} from "./core/auth/auth.service.js";
import { requireAuth, requireRole, tryAttachAuthUser } from "./core/middleware/auth.middleware.js";
import { CURRENT_PROGRAM_DOMAIN, JWT_SECRET, PLATFORM_SETUP_TOKEN } from "./core/config/env.js";
import { logger } from "./logger.js";
import { getDefaultTenantScope, getTenantScopeForUser } from "./tenant.js";
import { resolveProgramKey } from "./core/middleware/partition.middleware.js";

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
        displayName: string;
        identitySource?: string;
      };
    }) => Promise<AuthUserRecord>;
  };
};

/**
 * Derive AppInitState for the response.
 * - "not_initialized" : no users exist at all
 * - "no_org"          : user exists but has no org assignment
 * - "ready"           : user has org context
 */
function resolveAppInitState(user: AuthUserRecord): "not_initialized" | "no_org" | "ready" {
  if (!user.organizationId) return "no_org";
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

  const tenantScope = getTenantScopeForUser(user);
  const appInitState = resolveAppInitState(user);
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
    user: buildUserPayload(user, tenantScope.organizationId, programDomain),
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
  const tenantScope = getTenantScopeForUser(user);
  const appInitState = resolveAppInitState(user);
  res.json({
    user: buildUserPayload(user, tenantScope.organizationId, payload.programDomain),
    appInitialized: appInitState === "ready",
    appInitState,
  });
});

// POST /api/auth/program-token
// Exchanges a valid Suite JWT for a short-lived, program-scoped JWT.
// Used by program apps to obtain their own token when launched from the Suite.
//
// Body: { programDomain: string }
// Auth: Bearer Suite JWT (requireAuth)
//
// Returns: { token: string; user: {...} }
router.post("/program-token", requireAuth, async (req, res) => {
  const payload = getRequestUser(req);
  if (!payload) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const requestedDomain = typeof body.programDomain === "string" ? body.programDomain.trim() : "";
  if (!requestedDomain) {
    res.status(400).json({ error: "programDomain is required" });
    return;
  }

  const user = await prismaUser.user.findUnique({ where: { id: payload.userId } }) as AuthUserRecord | null;
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const orgId = user.organizationId ?? payload.organizationId;
  if (!orgId) {
    res.status(403).json({ error: "No organization context for this account" });
    return;
  }

  const programToken = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      platformRole: user.platformRole ?? "user",
      organizationId: orgId,
      programDomain: requestedDomain,
    },
    JWT_SECRET,
    { expiresIn: "8h" },
  );

  logger.info("[auth] program-token issued", {
    userId: user.id,
    organizationId: orgId,
    programDomain: requestedDomain,
  });

  res.json({
    token: programToken,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      organizationId: orgId,
      organizationName: user.organizationName ?? undefined,
      programDomain: requestedDomain,
    },
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
