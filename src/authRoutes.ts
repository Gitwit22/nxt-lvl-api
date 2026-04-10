import express from "express";
import jwt from "jsonwebtoken";
import { prisma } from "./core/db/prisma.js";
import {
  hashPassword,
  verifyPassword,
  signToken,
  getRequestUser,
} from "./core/auth/auth.service.js";
import { requireAuth, requireRole, tryAttachAuthUser } from "./core/middleware/auth.middleware.js";
import { CURRENT_PROGRAM_DOMAIN, PLATFORM_LAUNCH_TOKEN_SECRET, PLATFORM_SETUP_TOKEN } from "./core/config/env.js";
import { logger } from "./logger.js";
import { getDefaultTenantScope, getTenantScopeForUser } from "./tenant.js";
import { getProgramDefinition, programs } from "./core/config/programs.js";
import { resolveProgramKey } from "./core/middleware/partition.middleware.js";

const router = express.Router();

type AuthUserRecord = {
  id: string;
  email: string;
  passwordHash: string;
  role: string;
  displayName: string;
  organizationId?: string | null;
  organizationName?: string | null;
  identitySource?: string | null;
  platformUserId?: string | null;
};

const prismaUser = prisma as typeof prisma & {
  user: {
    findUnique: (args: { where: { email?: string; id?: string } }) => Promise<AuthUserRecord | null>;
    count: () => Promise<number>;
    update: (args: {
      where: { id: string };
      data: { passwordHash: string };
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
    displayName: user.displayName,
    organizationId,
    organizationName: user.organizationName ?? undefined,
    programDomain,
    identitySource: (user.identitySource ?? "local") as "platform" | "local",
  };
}

function resolveAuthProgramDomain(req: express.Request): string {
  const headerValue =
    typeof req.headers["x-app-partition"] === "string"
      ? req.headers["x-app-partition"]
      : undefined;

  const resolved = resolveProgramKey(headerValue);
  return getProgramDefinition(resolved) ? resolved : CURRENT_PROGRAM_DOMAIN;
}

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const programDomain = resolveAuthProgramDomain(req);
  const currentProgramAuthMode = programs[programDomain]?.authMode ?? "local_only";

  if (currentProgramAuthMode === "platform_only") {
    res.status(403).json({
      error: "Direct local login is deprecated for this app. Sign in through Suite.",
      code: "suite_login_required",
    });
    return;
  }

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
  organizationId: string;
  programDomain: string;
}) {
  return {
    id: payload.userId,
    email: payload.email,
    role: payload.role,
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
    data: { passwordHash: nextHash },
  });

  res.status(204).send();
});

// POST /api/auth/register
// - First user can always self-register (bootstrapping).
// - Hybrid-mode programs allow open self-registration for local accounts.
// - All other programs require admin JWT or PLATFORM_SETUP_TOKEN for subsequent users.
router.post(
  "/register",
  (req, res, next) => {
    const programDomain = resolveAuthProgramDomain(req);
    const currentProgramAuthMode = programs[programDomain]?.authMode ?? "local_only";

    if (currentProgramAuthMode === "platform_only") {
      res.status(403).json({
        error: "Direct local registration is deprecated for this app. Sign in through Suite.",
        code: "suite_login_required",
      });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const providedToken = typeof body.platformSetupToken === "string"
      ? body.platformSetupToken.trim()
      : typeof body.setupToken === "string" ? body.setupToken.trim() : "";
    if (PLATFORM_SETUP_TOKEN && providedToken && providedToken === PLATFORM_SETUP_TOKEN) {
      return next(); // valid setup token bypass
    }
    // Hybrid-mode programs allow open local registration
    const currentProgram = programs[programDomain];
    if (currentProgram?.authMode === "hybrid") {
      return next();
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

// POST /api/auth/launch-token
// Called by nxt-lvl-hub when a user clicks "Launch" on a program card.
// Issues a short-lived token the target program uses to auto-authenticate the user.
router.post("/launch-token", requireAuth, (req, res) => {
  const payload = getRequestUser(req);
  if (!payload) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const organizationId =
    typeof body.organizationId === "string" ? body.organizationId : payload.organizationId;
  const programDomain = typeof body.programDomain === "string" ? body.programDomain : "";

  if (!organizationId || !programDomain) {
    res.status(400).json({ error: "organizationId and programDomain are required" });
    return;
  }

  const launchToken = jwt.sign(
    {
      type: "launch",
      userId: payload.userId,
      email: payload.email,
      role: payload.role,
      organizationId,
      programDomain,
    },
    PLATFORM_LAUNCH_TOKEN_SECRET,
    { expiresIn: "5m" },
  );

  logger.info("[auth] launch token issued", {
    userId: payload.userId,
    organizationId,
    programDomain,
  });

  res.json({ launchToken });
});

// Timing-safe dummy hash comparison to prevent user enumeration on login miss
async function bcryptFakeCompare(): Promise<void> {
  await verifyPassword(
    "dummy",
    "$2a$12$invalidhashpaddingtomakeittimeconstant00000000000000000",
  );
}

export { router as authRouter };
