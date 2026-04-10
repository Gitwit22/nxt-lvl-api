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
import { programs } from "./core/config/programs.js";

const router = express.Router();
const currentProgramAuthMode = programs[CURRENT_PROGRAM_DOMAIN]?.authMode ?? "local_only";

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
function buildUserPayload(user: AuthUserRecord, organizationId: string) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    displayName: user.displayName,
    organizationId,
    organizationName: user.organizationName ?? undefined,
    programDomain: CURRENT_PROGRAM_DOMAIN,
    identitySource: (user.identitySource ?? "local") as "platform" | "local",
  };
}

// POST /api/auth/login
router.post("/login", async (req, res) => {
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
    programDomain: CURRENT_PROGRAM_DOMAIN,
  });
  logger.info("User logged in", { userId: user.id, role: user.role, organizationId: tenantScope.organizationId, programDomain: CURRENT_PROGRAM_DOMAIN });

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
    user: buildUserPayload(user, tenantScope.organizationId),
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
    user: user ? buildUserPayload(user, payload.organizationId) : buildUserPayloadFromToken(payload),
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

// POST /api/auth/register
// - First user can always self-register (bootstrapping).
// - Hybrid-mode programs allow open self-registration for local accounts.
// - All other programs require admin JWT or PLATFORM_SETUP_TOKEN for subsequent users.
router.post(
  "/register",
  (req, res, next) => {
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
    const currentProgram = programs[CURRENT_PROGRAM_DOMAIN];
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
      programDomain: CURRENT_PROGRAM_DOMAIN,
    });

    res.status(201).json({
      user: buildUserPayload(user, tenantScope.organizationId),
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
    user: buildUserPayload(user, tenantScope.organizationId),
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
