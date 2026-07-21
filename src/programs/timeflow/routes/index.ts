/**
 * Timeflow API Routes
 *
 * All endpoints are scoped by organizationId + userId extracted from the JWT.
 * The JWT must have programDomain === "timeflow" (issued by this consume endpoint
 * or by the suite platform-auth flow with programDomain: "timeflow").
 */
import express, { type NextFunction, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import fs from "fs";
import fsPromises from "fs/promises";
import crypto from "crypto";
import path from "path";
import { prisma } from "../../../core/db/prisma.js";
import {
  JWT_EXPIRES_IN,
  JWT_SECRET,
  TIMEFLOW_MAX_UPLOAD_BYTES,
  UPLOAD_DIR,
} from "../../../core/config/env.js";
import { hashPassword, verifyPassword } from "../../../core/auth/auth.service.js";
import { createDocumentPayload } from "../../../documentFactory.js";
import { sendTimeflowTeamInviteEmail } from "../../../core/services/email.service.js";
import { logger } from "../../../logger.js";
import { upload } from "../../../validators.js";
import {
  getR2SignedDownloadUrl,
  isR2Configured,
  isR2Key,
  uploadToR2,
} from "../../../core/storage/r2.js";

const router = express.Router();

const TIMEFLOW_PROGRAM_DOMAIN = "timeflow";

// ─── Auth helpers ─────────────────────────────────────────────────────────────

interface TimeflowTokenPayload {
  userId: string;
  email: string;
  role: string;
  organizationId: string;
  programDomain: string;
}

type TimeflowAuthRole = "owner" | "admin" | "manager" | "employee" | "viewer" | "contractor" | "client_viewer";
type TimeflowEntityType = "client" | "project" | "expense" | "invoice";

type TimeflowUserRecord = {
  id: string;
  email: string;
  passwordHash: string;
  role: string;
  organizationId: string | null;
  displayName: string;
  mustChangePassword?: boolean | null;
};

const prismaUser = prisma as typeof prisma & {
  user: {
    findUnique: (args: { where: { email?: string; id?: string } }) => Promise<TimeflowUserRecord | null>;
    create: (args: {
      data: {
        organizationId: string;
        email: string;
        passwordHash: string;
        role: string;
        displayName: string;
        identitySource?: string;
      };
    }) => Promise<TimeflowUserRecord>;
  };
};

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeDisplayName(value: unknown, fallbackEmail: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  return fallbackEmail.split("@")[0] || "User";
}

function createPendingOrganizationId() {
  return `unassigned-${crypto.randomUUID()}`;
}

function slugifyOrganizationName(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || `org-${Math.random().toString(36).slice(2, 8)}`;
}

function toTimeflowRole(value: string): TimeflowAuthRole {
  if (value === "owner") return "owner";
  if (value === "admin") return "admin";
  if (value === "manager") return "manager";
  if (value === "employee") return "employee";
  if (value === "viewer") return "viewer";
  if (value === "client_viewer") return "client_viewer";
  return "contractor";
}

function signTimeflowToken(user: {
  id: string;
  email: string;
  role: string;
  organizationId: string | null;
}): string {
  const organizationId = user.organizationId || createPendingOrganizationId();
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      organizationId,
      programDomain: TIMEFLOW_PROGRAM_DOMAIN,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions,
  );
}

function writeAuthCookies(res: Response, token: string): void {
  const secureCookie = process.env.NODE_ENV === "production";
  const baseCookie = {
    httpOnly: true,
    secure: secureCookie,
    sameSite: (secureCookie ? "none" : "lax") as "none" | "lax",
    maxAge: 8 * 60 * 60 * 1000,
    path: "/",
  };

  res.cookie("accessToken", token, baseCookie);
  res.cookie("token", token, baseCookie);
  res.cookie("timeflowToken", token, baseCookie);
}

function toAuthUserPayload(user: TimeflowUserRecord) {
  const organizationId = user.organizationId || createPendingOrganizationId();
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: toTimeflowRole(user.role),
    organizationId,
    programDomain: TIMEFLOW_PROGRAM_DOMAIN,
    mustChangePassword: user.mustChangePassword ?? false,
  };
}

async function getUserOrgMemberships(userId: string) {
  const memberships = await prisma.membership.findMany({
    where: { userId },
    include: {
      organization: {
        select: { id: true, name: true, slug: true, status: true, isActive: true },
      },
    },
  });

  return memberships
    .filter((membership) => membership.organization?.isActive !== false && membership.organization?.status !== "archived")
    .map((membership) => ({
      organizationId: membership.organizationId,
      role: membership.role,
      organizationName: membership.organization?.name ?? "Organization",
    }));
}

// ─── TimeFlow direct auth endpoints (DB-backed) ─────────────────────────────

router.post("/auth/login", async (req, res) => {
  const body = isRecord(req.body) ? req.body : {};
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  const user = await prismaUser.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const token = signTimeflowToken(user);
  const memberships = await getUserOrgMemberships(user.id);
  writeAuthCookies(res, token);
  res.setHeader("Authorization", `Bearer ${token}`);

  logger.info("[timeflow] direct login success", {
    userId: user.id,
    role: user.role,
    organizationId: user.organizationId,
    memberships: memberships.length,
  });

  res.json({ token, user: toAuthUserPayload(user), onboardingRequired: memberships.length === 0 });
});

router.post("/auth/register", async (req, res) => {
  const body = isRecord(req.body) ? req.body : {};
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  const displayName = normalizeDisplayName(body.displayName, email);

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

  const user = await prismaUser.user.create({
    data: {
      organizationId: createPendingOrganizationId(),
      email,
      passwordHash: await hashPassword(password),
      role: "contractor",
      displayName,
      identitySource: "local",
    },
  });

  const token = signTimeflowToken(user);
  writeAuthCookies(res, token);
  res.setHeader("Authorization", `Bearer ${token}`);

  logger.info("[timeflow] direct register success", {
    userId: user.id,
    role: user.role,
    organizationId: user.organizationId,
    onboardingRequired: true,
  });

  res.status(201).json({ token, user: toAuthUserPayload(user), onboardingRequired: true });
});

router.get("/auth/me", requireTimeflowAuth, async (req, res) => {
  const payload = getUser(req);
  const user = await prismaUser.user.findUnique({ where: { id: payload.userId } });
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }

  const memberships = await getUserOrgMemberships(user.id);
  res.json({ user: toAuthUserPayload(user), onboardingRequired: memberships.length === 0 });
});

// ─── Post-signup organization onboarding ────────────────────────────────────

router.get("/setup-organization/status", requireTimeflowAuth, async (req, res) => {
  const payload = getUser(req);
  const user = await prismaUser.user.findUnique({ where: { id: payload.userId } });
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }

  const memberships = await getUserOrgMemberships(user.id);
  res.json({
    onboardingRequired: memberships.length === 0,
    memberships,
    user: toAuthUserPayload(user),
  });
});

router.post("/setup-organization/create", requireTimeflowAuth, async (req, res) => {
  const payload = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const organizationName = typeof body.organizationName === "string" ? body.organizationName.trim() : "";

  if (!organizationName) {
    res.status(400).json({ error: "organizationName is required" });
    return;
  }

  const user = await prismaUser.user.findUnique({ where: { id: payload.userId } });
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }

  const baseSlug = slugifyOrganizationName(organizationName);
  let slug = baseSlug;
  let sequence = 1;
  // Keep slug unique in a simple deterministic way.
  while (await prisma.organization.findFirst({ where: { slug } })) {
    sequence += 1;
    slug = `${baseSlug}-${sequence}`;
  }

  const organization = await prisma.organization.create({
    data: {
      name: organizationName,
      slug,
      ownerEmail: user.email,
      contactEmail: user.email,
      status: "active",
      isActive: true,
    },
  });

  await prisma.membership.create({
    data: {
      userId: user.id,
      organizationId: organization.id,
      role: "owner",
    },
  });

  await (prisma as unknown as {
    timeflowWorkspaceMeta: { upsert: (args: Record<string, unknown>) => Promise<unknown> };
  }).timeflowWorkspaceMeta.upsert({
    where: { organizationId: organization.id },
    create: { organizationId: organization.id, workspaceType: "solo", teamEnabled: false, isDefault: true },
    update: { workspaceType: "solo", teamEnabled: false, isDefault: true },
  });

  const updatedUser = await prisma.user.update({
    where: { id: user.id },
    data: {
      organizationId: organization.id,
      role: "owner",
    },
  }) as unknown as TimeflowUserRecord;

  await prisma.timeflowSettings.upsert({
    where: { organizationId_userId: { organizationId: organization.id, userId: user.id } },
    create: {
      organizationId: organization.id,
      userId: user.id,
      businessName: organizationName,
      invoiceFrequency: "monthly",
      periodWeekStartsOn: 1,
      periodTargetHours: 0,
      periodTargetEarnings: 0,
    },
    update: {
      businessName: organizationName,
    },
  });

  const token = signTimeflowToken(updatedUser);
  writeAuthCookies(res, token);
  res.setHeader("Authorization", `Bearer ${token}`);

  res.status(201).json({
    token,
    user: toAuthUserPayload(updatedUser),
    organization: { id: organization.id, name: organization.name, slug: organization.slug },
    onboardingRequired: false,
  });
});

router.post("/setup-organization/solo", requireTimeflowAuth, async (req, res) => {
  const payload = getUser(req);
  const user = await prismaUser.user.findUnique({ where: { id: payload.userId } });
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }

  const baseName = user.displayName?.trim() || user.email.split("@")[0] || "Solo";
  const organizationName = `${baseName}'s Workspace`;
  const baseSlug = slugifyOrganizationName(`${baseName}-workspace`);
  let slug = baseSlug;
  let sequence = 1;
  while (await prisma.organization.findFirst({ where: { slug } })) {
    sequence += 1;
    slug = `${baseSlug}-${sequence}`;
  }

  const organization = await prisma.organization.create({
    data: {
      name: organizationName,
      slug,
      ownerEmail: user.email,
      contactEmail: user.email,
      status: "active",
      isActive: true,
    },
  });

  await prisma.membership.create({
    data: {
      userId: user.id,
      organizationId: organization.id,
      role: "owner",
    },
  });

  await (prisma as unknown as {
    timeflowWorkspaceMeta: { upsert: (args: Record<string, unknown>) => Promise<unknown> };
  }).timeflowWorkspaceMeta.upsert({
    where: { organizationId: organization.id },
    create: { organizationId: organization.id, workspaceType: "solo", teamEnabled: false, isDefault: true },
    update: { workspaceType: "solo", teamEnabled: false, isDefault: true },
  });

  const updatedUser = await prisma.user.update({
    where: { id: user.id },
    data: {
      organizationId: organization.id,
      role: "owner",
    },
  }) as unknown as TimeflowUserRecord;

  await prisma.timeflowSettings.upsert({
    where: { organizationId_userId: { organizationId: organization.id, userId: user.id } },
    create: {
      organizationId: organization.id,
      userId: user.id,
      businessName: organizationName,
      invoiceFrequency: "monthly",
      periodWeekStartsOn: 1,
      periodTargetHours: 0,
      periodTargetEarnings: 0,
    },
    update: {
      businessName: organizationName,
    },
  });

  const token = signTimeflowToken(updatedUser);
  writeAuthCookies(res, token);
  res.setHeader("Authorization", `Bearer ${token}`);

  res.status(201).json({
    token,
    user: toAuthUserPayload(updatedUser),
    organization: { id: organization.id, name: organization.name, slug: organization.slug },
    onboardingRequired: false,
  });
});

router.post("/setup-organization/join", requireTimeflowAuth, async (req, res) => {
  const payload = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const inviteToken = typeof body.inviteToken === "string" ? body.inviteToken.trim() : "";

  if (!inviteToken) {
    res.status(400).json({ error: "inviteToken is required" });
    return;
  }

  const user = await prismaUser.user.findUnique({ where: { id: payload.userId } });
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }

  const invitation = await prisma.orgInvitation.findFirst({
    where: {
      token: inviteToken,
      status: "pending",
      email: user.email,
      expiresAt: { gt: new Date() },
    },
  });

  if (!invitation) {
    res.status(404).json({ error: "Invite not found, expired, or already used" });
    return;
  }

  const existingMembership = await prisma.membership.findFirst({
    where: {
      userId: user.id,
      organizationId: invitation.organizationId,
    },
  });

  if (!existingMembership) {
    await prisma.membership.create({
      data: {
        userId: user.id,
        organizationId: invitation.organizationId,
        role: invitation.role || "member",
      },
    });
  }

  await prisma.orgInvitation.update({
    where: { id: invitation.id },
    data: { status: "accepted" },
  });

  const joinedOrganization = await prisma.organization.findFirst({ where: { id: invitation.organizationId } });

  const updatedUser = await prisma.user.update({
    where: { id: user.id },
    data: { organizationId: invitation.organizationId },
  }) as unknown as TimeflowUserRecord;

  const token = signTimeflowToken(updatedUser);
  writeAuthCookies(res, token);
  res.setHeader("Authorization", `Bearer ${token}`);

  res.status(200).json({
    token,
    user: toAuthUserPayload(updatedUser),
    organization: joinedOrganization
      ? { id: joinedOrganization.id, name: joinedOrganization.name, slug: joinedOrganization.slug }
      : undefined,
    onboardingRequired: false,
  });
});

// ─── Viewer invite endpoints ─────────────────────────────────────────────────

const INVITE_SECRET = (process.env.INVITE_SECRET || process.env.JWT_SECRET || "invite-secret-fallback");
const INVITE_EXPIRES_IN = "7d";

router.post("/auth/invite/generate", requireTimeflowAuth, async (req, res) => {
  const actor = getUser(req);
  if (!["contractor", "owner", "admin", "manager"].includes(actor.role)) {
    res.status(403).json({ error: "Only workspace admins can generate viewer invites" });
    return;
  }

  const body = isRecord(req.body) ? req.body : {};
  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  if (!clientId) {
    res.status(400).json({ error: "clientId is required" });
    return;
  }

  const code = jwt.sign(
    {
      type: "viewer-invite",
      clientId,
      createdBy: actor.userId,
      organizationId: actor.organizationId,
      programDomain: TIMEFLOW_PROGRAM_DOMAIN,
    },
    INVITE_SECRET,
    { expiresIn: INVITE_EXPIRES_IN } as jwt.SignOptions,
  );

  res.json({ code, expiresIn: INVITE_EXPIRES_IN });
});

router.post("/auth/invite/accept", async (req, res) => {
  const body = isRecord(req.body) ? req.body : {};
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  const displayName = normalizeDisplayName(body.displayName, email);

  if (!code || !email || !password) {
    res.status(400).json({ error: "code, email, and password are required" });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  let payload: { type?: string; clientId?: string; organizationId?: string } | null = null;
  try {
    payload = jwt.verify(code, INVITE_SECRET) as typeof payload;
  } catch {
    res.status(400).json({ error: "Invite code is invalid or has expired" });
    return;
  }

  if (payload?.type !== "viewer-invite" || !payload.clientId) {
    res.status(400).json({ error: "Invalid invite code format" });
    return;
  }

  const existing = await prismaUser.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ error: "An account with that email already exists" });
    return;
  }

  const user = await prismaUser.user.create({
    data: {
      organizationId: payload.organizationId || createPendingOrganizationId(),
      email,
      passwordHash: await hashPassword(password),
      role: "client_viewer",
      displayName,
      identitySource: "invite",
    },
  });

  // Store the clientId association in user metadata if supported, otherwise embed in token.
  const token = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId,
      programDomain: TIMEFLOW_PROGRAM_DOMAIN,
      clientId: payload.clientId,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions,
  );

  writeAuthCookies(res, token);
  res.setHeader("Authorization", `Bearer ${token}`);

  logger.info("[timeflow] viewer invite accepted", {
    userId: user.id,
    clientId: payload.clientId,
    organizationId: user.organizationId,
  });

  res.status(201).json({ token, user: { ...toAuthUserPayload(user), clientId: payload.clientId } });
});

router.post("/auth/logout", (_req, res) => {
  const secureCookie = process.env.NODE_ENV === "production";
  const cookieOptions = {
    httpOnly: true,
    secure: secureCookie,
    sameSite: (secureCookie ? "none" : "lax") as "none" | "lax",
    path: "/",
  };

  res.clearCookie("accessToken", cookieOptions);
  res.clearCookie("token", cookieOptions);
  res.clearCookie("timeflowToken", cookieOptions);
  res.status(204).send();
});

function readTokenFromRequest(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);

  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;

  const cookieValues = new Map<string, string>();
  for (const item of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = item.trim().split("=");
    const key = rawKey?.trim();
    if (!key) continue;
    cookieValues.set(key, decodeURIComponent(rawValue.join("=") || ""));
  }

  // Prefer program-scoped cookies before generic token names to avoid
  // collisions with other app/session cookies on the same domain.
  const preferredOrder = ["timeflowToken", "accessToken", "token", "authToken"];
  for (const key of preferredOrder) {
    const token = cookieValues.get(key);
    if (token) return token;
  }

  return undefined;
}

function decodeTimeflowToken(token: string): TimeflowTokenPayload | undefined {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as TimeflowTokenPayload;
    if (payload.programDomain !== TIMEFLOW_PROGRAM_DOMAIN) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

function requireTimeflowAuth(req: Request, res: Response, next: NextFunction): void {
  const token = readTokenFromRequest(req);
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const payload = decodeTimeflowToken(token);
  if (!payload) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }
  (req as Request & { timeflowUser: TimeflowTokenPayload }).timeflowUser = payload;
  next();
}

function getUser(req: Request): TimeflowTokenPayload {
  return (req as Request & { timeflowUser: TimeflowTokenPayload }).timeflowUser;
}

function getScopeDebug(req: Request): { tokenUserId: string; effectiveUserId: string } | null {
  const payload = (req as Request & { timeflowScopeDebug?: { tokenUserId: string; effectiveUserId: string } }).timeflowScopeDebug;
  if (!payload) return null;
  return payload;
}

/**
 * Resolve the effective Timeflow data owner for the current authenticated user.
 *
 * Why this exists:
 * - Timeflow records are scoped by organizationId + userId.
 * - Some tenants have legacy records under a prior userId after auth migrations.
 * - If the current user has no owned records and there is exactly one distinct
 *   owner with data in this org, use that owner id for data access.
 *
 * Safety:
 * - Only falls back when current user has zero data records.
 * - Only falls back when exactly one legacy owner is detected.
 * - Does not use settings rows for ownership detection, since settings can be
 *   auto-created and would mask legacy data.
 */
async function resolveEffectiveDataUserId(scope: { organizationId: string; userId: string }): Promise<string> {
  const store = prisma as unknown as {
    timeflowClient: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      findMany: (args: Record<string, unknown>) => Promise<Array<{ userId: string }>>;
    };
    timeflowProject: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      findMany: (args: Record<string, unknown>) => Promise<Array<{ userId: string }>>;
    };
    timeflowTimeEntry: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      findMany: (args: Record<string, unknown>) => Promise<Array<{ userId: string }>>;
    };
    timeflowInvoice: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      findMany: (args: Record<string, unknown>) => Promise<Array<{ userId: string }>>;
    };
    timeflowProjectBill: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      findMany: (args: Record<string, unknown>) => Promise<Array<{ userId: string }>>;
    };
  };

  const [ownClient, ownProject, ownEntry, ownInvoice, ownProjectBill] = await Promise.all([
    store.timeflowClient.findFirst({ where: { organizationId: scope.organizationId, userId: scope.userId }, select: { id: true } }),
    store.timeflowProject.findFirst({ where: { organizationId: scope.organizationId, userId: scope.userId }, select: { id: true } }),
    store.timeflowTimeEntry.findFirst({ where: { organizationId: scope.organizationId, userId: scope.userId }, select: { id: true } }),
    store.timeflowInvoice.findFirst({ where: { organizationId: scope.organizationId, userId: scope.userId }, select: { id: true } }),
    store.timeflowProjectBill.findFirst({ where: { organizationId: scope.organizationId, userId: scope.userId }, select: { id: true } }),
  ]);

  if (ownClient || ownProject || ownEntry || ownInvoice || ownProjectBill) {
    return scope.userId;
  }

  const ownerIds = new Set<string>();
  const addOwnerIds = (rows: Array<{ userId: string }>) => {
    for (const row of rows) {
      if (typeof row.userId === "string" && row.userId.trim()) {
        ownerIds.add(row.userId);
      }
    }
  };

  const [clientOwners, projectOwners, entryOwners, invoiceOwners, projectBillOwners] = await Promise.all([
    store.timeflowClient.findMany({ where: { organizationId: scope.organizationId }, select: { userId: true }, distinct: ["userId"] }),
    store.timeflowProject.findMany({ where: { organizationId: scope.organizationId }, select: { userId: true }, distinct: ["userId"] }),
    store.timeflowTimeEntry.findMany({ where: { organizationId: scope.organizationId }, select: { userId: true }, distinct: ["userId"] }),
    store.timeflowInvoice.findMany({ where: { organizationId: scope.organizationId }, select: { userId: true }, distinct: ["userId"] }),
    store.timeflowProjectBill.findMany({ where: { organizationId: scope.organizationId }, select: { userId: true }, distinct: ["userId"] }),
  ]);

  addOwnerIds(clientOwners);
  addOwnerIds(projectOwners);
  addOwnerIds(entryOwners);
  addOwnerIds(invoiceOwners);
  addOwnerIds(projectBillOwners);

  if (ownerIds.size !== 1) {
    return scope.userId;
  }

  const [legacyOwnerId] = Array.from(ownerIds);
  if (!legacyOwnerId || legacyOwnerId === scope.userId) {
    return scope.userId;
  }

  logger.warn("[timeflow] using legacy data owner fallback", {
    organizationId: scope.organizationId,
    userId: scope.userId,
    legacyOwnerId,
  });

  return legacyOwnerId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTimeflowEntityType(value: unknown): value is TimeflowEntityType {
  return value === "client" || value === "project" || value === "expense" || value === "invoice";
}

function buildEntitySourceReference(entityType: TimeflowEntityType, entityId: string): string {
  return `timeflow:${entityType}:${entityId}`;
}

function parseEntitySourceReference(sourceReference: string | null | undefined): {
  entityType: TimeflowEntityType;
  entityId: string;
} | null {
  if (!sourceReference?.startsWith("timeflow:")) return null;
  const [prefix, entityType, ...entityIdParts] = sourceReference.split(":");
  if (prefix !== "timeflow" || !isTimeflowEntityType(entityType) || entityIdParts.length === 0) return null;
  return { entityType, entityId: entityIdParts.join(":") };
}

function asAttachmentStatus(value: unknown): "active" | "archived" {
  return value === "archived" ? "archived" : "active";
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function makeSafeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "document";
}

function buildTimeflowR2Key(input: {
  organizationId: string;
  entityType?: TimeflowEntityType;
  entityId?: string;
  safeFilename: string;
  stamp: string;
}): string {
  const scopedEntityType = input.entityType || "document";
  const scopedEntityId = input.entityId || "unscoped";

  return [
    "timeflow",
    input.organizationId,
    scopedEntityType,
    scopedEntityId,
    `${input.stamp}-${input.safeFilename}`,
  ]
    .map((segment) => segment.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

async function assertTimeflowEntityAccess(
  entityType: TimeflowEntityType,
  entityId: string,
  scope: { organizationId: string; userId: string },
): Promise<boolean> {
  const store = prisma as unknown as {
    timeflowClient: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
    timeflowProject: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
    timeflowExpense: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
    timeflowInvoice: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  };

  if (entityType === "client") {
    const client = await store.timeflowClient.findFirst({
      where: { id: entityId, organizationId: scope.organizationId, userId: scope.userId, isActive: true },
    });
    return Boolean(client);
  }

  if (entityType === "project") {
    const project = await store.timeflowProject.findFirst({
      where: { id: entityId, organizationId: scope.organizationId, userId: scope.userId, isActive: true },
    });
    return Boolean(project);
  }

  if (entityType === "expense") {
    const expense = await store.timeflowExpense.findFirst({
      where: { id: entityId, organizationId: scope.organizationId, userId: scope.userId },
    });
    return Boolean(expense);
  }

  const invoice = await store.timeflowInvoice.findFirst({
    where: { id: entityId, organizationId: scope.organizationId, userId: scope.userId },
  });
  return Boolean(invoice);
}

function toTimeflowDocumentRecord(doc: {
  id: string;
  title: string;
  originalFileName: string | null;
  author: string;
  createdAt: Date;
  updatedAt: Date;
  status: string | null;
  mimeType: string | null;
  fileSize: number | null;
  filePath: string | null;
  sourceReference: string | null;
  extractedMetadata: unknown;
}) {
  const entity = parseEntitySourceReference(doc.sourceReference);
  const metadata = isRecord(doc.extractedMetadata) ? doc.extractedMetadata : {};
  const timeflowMeta = isRecord(metadata.timeflow) ? metadata.timeflow : {};

  return {
    id: doc.id,
    entityType: entity?.entityType,
    entityId: entity?.entityId,
    title: doc.title,
    originalFilename: doc.originalFileName || "document",
    note: typeof timeflowMeta.note === "string" ? timeflowMeta.note : undefined,
    uploadedBy: asString(timeflowMeta.uploadedBy) || doc.author || "Unknown uploader",
    uploadedAt: asString(timeflowMeta.uploadedAt) || doc.createdAt.toISOString(),
    status: asAttachmentStatus(timeflowMeta.status || doc.status),
    mimeType: doc.mimeType || "application/octet-stream",
    sizeBytes: doc.fileSize || 0,
    storageKey: asString(timeflowMeta.storageKey) || doc.filePath || undefined,
    dataUrl: "",
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

// All routes below require a valid Timeflow JWT.
router.use(requireTimeflowAuth);

// Normalize data scope for migrated/legacy tenants before all Timeflow handlers.
router.use(async (req, res, next) => {
  try {
    const payload = getUser(req);
    const tokenUserId = payload.userId;

    // Multi-workspace support: if the client sends x-active-workspace-id and
    // the user has a membership in that org, use it as the scoped org instead
    // of the JWT's stored organizationId. This allows switching workspaces
    // without re-issuing a JWT.
    const requestedWorkspaceId = req.headers["x-active-workspace-id"];
    if (typeof requestedWorkspaceId === "string" && requestedWorkspaceId.trim()) {
      const membershipCheck = await (prisma as unknown as {
        membership: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
      }).membership.findFirst({
        where: { userId: payload.userId, organizationId: requestedWorkspaceId.trim() },
      });
      if (membershipCheck) {
        payload.organizationId = requestedWorkspaceId.trim();
      }
    }

    const effectiveUserId = await resolveEffectiveDataUserId({
      organizationId: payload.organizationId,
      userId: payload.userId,
    });

    (req as Request & { timeflowScopeDebug?: { tokenUserId: string; effectiveUserId: string } }).timeflowScopeDebug = {
      tokenUserId,
      effectiveUserId,
    };

    res.setHeader("x-timeflow-org-id", payload.organizationId);
    res.setHeader("x-timeflow-token-user-id", tokenUserId);
    res.setHeader("x-timeflow-effective-user-id", effectiveUserId);

    payload.userId = effectiveUserId;
    next();
  } catch (error) {
    next(error as Error);
  }
});

// Debug endpoint for live tenant/user scope diagnostics.
router.get("/debug/context", async (req, res) => {
  const { organizationId, userId, email } = getUser(req);
  const scopeDebug = getScopeDebug(req);
  const tokenUserId = scopeDebug?.tokenUserId ?? userId;
  const effectiveUserId = scopeDebug?.effectiveUserId ?? userId;

  const [
    tokenClientCount,
    tokenProjectCount,
    tokenEntryCount,
    tokenInvoiceCount,
    tokenProjectBillCount,
    effectiveClientCount,
    effectiveProjectCount,
    effectiveEntryCount,
    effectiveInvoiceCount,
    effectiveProjectBillCount,
    orgClientOwners,
    orgProjectOwners,
    orgEntryOwners,
    orgInvoiceOwners,
    orgProjectBillOwners,
  ] = await Promise.all([
    prisma.timeflowClient.count({ where: { organizationId, userId: tokenUserId } }),
    prisma.timeflowProject.count({ where: { organizationId, userId: tokenUserId } }),
    prisma.timeflowTimeEntry.count({ where: { organizationId, userId: tokenUserId } }),
    prisma.timeflowInvoice.count({ where: { organizationId, userId: tokenUserId } }),
    prisma.timeflowProjectBill.count({ where: { organizationId, userId: tokenUserId } }),
    prisma.timeflowClient.count({ where: { organizationId, userId: effectiveUserId } }),
    prisma.timeflowProject.count({ where: { organizationId, userId: effectiveUserId } }),
    prisma.timeflowTimeEntry.count({ where: { organizationId, userId: effectiveUserId } }),
    prisma.timeflowInvoice.count({ where: { organizationId, userId: effectiveUserId } }),
    prisma.timeflowProjectBill.count({ where: { organizationId, userId: effectiveUserId } }),
    prisma.timeflowClient.findMany({ where: { organizationId }, select: { userId: true }, distinct: ["userId"] }),
    prisma.timeflowProject.findMany({ where: { organizationId }, select: { userId: true }, distinct: ["userId"] }),
    prisma.timeflowTimeEntry.findMany({ where: { organizationId }, select: { userId: true }, distinct: ["userId"] }),
    prisma.timeflowInvoice.findMany({ where: { organizationId }, select: { userId: true }, distinct: ["userId"] }),
    prisma.timeflowProjectBill.findMany({ where: { organizationId }, select: { userId: true }, distinct: ["userId"] }),
  ]);

  res.json({
    email,
    organizationId,
    tokenUserId,
    effectiveUserId,
    counts: {
      tokenUser: {
        clients: tokenClientCount,
        projects: tokenProjectCount,
        timeEntries: tokenEntryCount,
        invoices: tokenInvoiceCount,
        projectBills: tokenProjectBillCount,
      },
      effectiveUser: {
        clients: effectiveClientCount,
        projects: effectiveProjectCount,
        timeEntries: effectiveEntryCount,
        invoices: effectiveInvoiceCount,
        projectBills: effectiveProjectBillCount,
      },
    },
    ownersInOrganization: {
      clients: orgClientOwners.map((row) => row.userId),
      projects: orgProjectOwners.map((row) => row.userId),
      timeEntries: orgEntryOwners.map((row) => row.userId),
      invoices: orgInvoiceOwners.map((row) => row.userId),
      projectBills: orgProjectBillOwners.map((row) => row.userId),
    },
  });
});

// Deeper diagnostics to determine whether data exists in another org/user scope.
router.get("/debug/presence", async (req, res) => {
  const { organizationId, userId, email } = getUser(req);

  const [
    globalClientCount,
    globalProjectCount,
    globalEntryCount,
    globalInvoiceCount,
    globalProjectBillCount,
    orgClientCount,
    orgProjectCount,
    orgEntryCount,
    orgInvoiceCount,
    orgProjectBillCount,
    userClientOrgs,
    userProjectOrgs,
    userEntryOrgs,
    userInvoiceOrgs,
    userProjectBillOrgs,
    orgClientOwners,
    orgProjectOwners,
    orgEntryOwners,
    orgInvoiceOwners,
    orgProjectBillOwners,
  ] = await Promise.all([
    prisma.timeflowClient.count(),
    prisma.timeflowProject.count(),
    prisma.timeflowTimeEntry.count(),
    prisma.timeflowInvoice.count(),
    prisma.timeflowProjectBill.count(),
    prisma.timeflowClient.count({ where: { organizationId } }),
    prisma.timeflowProject.count({ where: { organizationId } }),
    prisma.timeflowTimeEntry.count({ where: { organizationId } }),
    prisma.timeflowInvoice.count({ where: { organizationId } }),
    prisma.timeflowProjectBill.count({ where: { organizationId } }),
    prisma.timeflowClient.findMany({ where: { userId }, select: { organizationId: true }, distinct: ["organizationId"] }),
    prisma.timeflowProject.findMany({ where: { userId }, select: { organizationId: true }, distinct: ["organizationId"] }),
    prisma.timeflowTimeEntry.findMany({ where: { userId }, select: { organizationId: true }, distinct: ["organizationId"] }),
    prisma.timeflowInvoice.findMany({ where: { userId }, select: { organizationId: true }, distinct: ["organizationId"] }),
    prisma.timeflowProjectBill.findMany({ where: { userId }, select: { organizationId: true }, distinct: ["organizationId"] }),
    prisma.timeflowClient.findMany({ where: { organizationId }, select: { userId: true }, distinct: ["userId"] }),
    prisma.timeflowProject.findMany({ where: { organizationId }, select: { userId: true }, distinct: ["userId"] }),
    prisma.timeflowTimeEntry.findMany({ where: { organizationId }, select: { userId: true }, distinct: ["userId"] }),
    prisma.timeflowInvoice.findMany({ where: { organizationId }, select: { userId: true }, distinct: ["userId"] }),
    prisma.timeflowProjectBill.findMany({ where: { organizationId }, select: { userId: true }, distinct: ["userId"] }),
  ]);

  const userOrgSet = new Set<string>();
  for (const row of userClientOrgs) userOrgSet.add(row.organizationId);
  for (const row of userProjectOrgs) userOrgSet.add(row.organizationId);
  for (const row of userEntryOrgs) userOrgSet.add(row.organizationId);
  for (const row of userInvoiceOrgs) userOrgSet.add(row.organizationId);
  for (const row of userProjectBillOrgs) userOrgSet.add(row.organizationId);

  const userOrgIds = Array.from(userOrgSet);

  const userOrgBreakdown = await Promise.all(
    userOrgIds.map(async (orgId) => {
      const [clients, projects, timeEntries, invoices, projectBills] = await Promise.all([
        prisma.timeflowClient.count({ where: { organizationId: orgId, userId } }),
        prisma.timeflowProject.count({ where: { organizationId: orgId, userId } }),
        prisma.timeflowTimeEntry.count({ where: { organizationId: orgId, userId } }),
        prisma.timeflowInvoice.count({ where: { organizationId: orgId, userId } }),
        prisma.timeflowProjectBill.count({ where: { organizationId: orgId, userId } }),
      ]);
      return { organizationId: orgId, clients, projects, timeEntries, invoices, projectBills };
    }),
  );

  res.json({
    email,
    organizationId,
    userId,
    globalTotals: {
      clients: globalClientCount,
      projects: globalProjectCount,
      timeEntries: globalEntryCount,
      invoices: globalInvoiceCount,
      projectBills: globalProjectBillCount,
    },
    currentOrgTotals: {
      clients: orgClientCount,
      projects: orgProjectCount,
      timeEntries: orgEntryCount,
      invoices: orgInvoiceCount,
      projectBills: orgProjectBillCount,
    },
    userOrgBreakdown,
    ownersInCurrentOrg: {
      clients: orgClientOwners.map((row) => row.userId),
      projects: orgProjectOwners.map((row) => row.userId),
      timeEntries: orgEntryOwners.map((row) => row.userId),
      invoices: orgInvoiceOwners.map((row) => row.userId),
      projectBills: orgProjectBillOwners.map((row) => row.userId),
    },
  });
});

// One-time recovery endpoint: move this user's Timeflow data from a legacy org
// to the current token org when the current org has no Timeflow rows.
router.post("/debug/relink-current-org", async (req, res) => {
  const { organizationId: currentOrgId, userId, email } = getUser(req);

  const [currentClients, currentProjects, currentEntries, currentInvoices, currentProjectBills] = await Promise.all([
    prisma.timeflowClient.count({ where: { organizationId: currentOrgId, userId } }),
    prisma.timeflowProject.count({ where: { organizationId: currentOrgId, userId } }),
    prisma.timeflowTimeEntry.count({ where: { organizationId: currentOrgId, userId } }),
    prisma.timeflowInvoice.count({ where: { organizationId: currentOrgId, userId } }),
    prisma.timeflowProjectBill.count({ where: { organizationId: currentOrgId, userId } }),
  ]);

  const currentTotal = currentClients + currentProjects + currentEntries + currentInvoices + currentProjectBills;
  if (currentTotal > 0) {
    res.status(409).json({
      error: "Current organization already has Timeflow rows for this user. Relink aborted.",
      currentOrgId,
      userId,
      counts: {
        clients: currentClients,
        projects: currentProjects,
        timeEntries: currentEntries,
        invoices: currentInvoices,
        projectBills: currentProjectBills,
      },
    });
    return;
  }

  const [legacyClientOrgs, legacyProjectOrgs, legacyEntryOrgs, legacyInvoiceOrgs, legacyProjectBillOrgs] = await Promise.all([
    prisma.timeflowClient.findMany({ where: { userId, organizationId: { not: currentOrgId } }, select: { organizationId: true }, distinct: ["organizationId"] }),
    prisma.timeflowProject.findMany({ where: { userId, organizationId: { not: currentOrgId } }, select: { organizationId: true }, distinct: ["organizationId"] }),
    prisma.timeflowTimeEntry.findMany({ where: { userId, organizationId: { not: currentOrgId } }, select: { organizationId: true }, distinct: ["organizationId"] }),
    prisma.timeflowInvoice.findMany({ where: { userId, organizationId: { not: currentOrgId } }, select: { organizationId: true }, distinct: ["organizationId"] }),
    prisma.timeflowProjectBill.findMany({ where: { userId, organizationId: { not: currentOrgId } }, select: { organizationId: true }, distinct: ["organizationId"] }),
  ]);

  const legacyOrgSet = new Set<string>();
  for (const row of legacyClientOrgs) legacyOrgSet.add(row.organizationId);
  for (const row of legacyProjectOrgs) legacyOrgSet.add(row.organizationId);
  for (const row of legacyEntryOrgs) legacyOrgSet.add(row.organizationId);
  for (const row of legacyInvoiceOrgs) legacyOrgSet.add(row.organizationId);
  for (const row of legacyProjectBillOrgs) legacyOrgSet.add(row.organizationId);

  if (legacyOrgSet.size === 0) {
    res.status(404).json({
      error: "No legacy Timeflow data found for this user outside the current organization.",
      currentOrgId,
      userId,
    });
    return;
  }

  if (legacyOrgSet.size > 1) {
    res.status(409).json({
      error: "Multiple legacy organizations found. Manual relink required.",
      currentOrgId,
      userId,
      legacyOrgIds: Array.from(legacyOrgSet),
    });
    return;
  }

  const [sourceOrgId] = Array.from(legacyOrgSet);

  const sourceSettings = await prisma.timeflowSettings.findUnique({
    where: { organizationId_userId: { organizationId: sourceOrgId, userId } },
  });
  const targetSettings = await prisma.timeflowSettings.findUnique({
    where: { organizationId_userId: { organizationId: currentOrgId, userId } },
  });

  const result = await prisma.$transaction(async (tx) => {
    const [clientsMoved, projectsMoved, entriesMoved, invoicesMoved, projectBillsMoved, documentsMoved] = await Promise.all([
      tx.timeflowClient.updateMany({ where: { organizationId: sourceOrgId, userId }, data: { organizationId: currentOrgId } }),
      tx.timeflowProject.updateMany({ where: { organizationId: sourceOrgId, userId }, data: { organizationId: currentOrgId } }),
      tx.timeflowTimeEntry.updateMany({ where: { organizationId: sourceOrgId, userId }, data: { organizationId: currentOrgId } }),
      tx.timeflowInvoice.updateMany({ where: { organizationId: sourceOrgId, userId }, data: { organizationId: currentOrgId } }),
      tx.timeflowProjectBill.updateMany({ where: { organizationId: sourceOrgId, userId }, data: { organizationId: currentOrgId } }),
      tx.document.updateMany({
        where: {
          organizationId: sourceOrgId,
          programDomain: TIMEFLOW_PROGRAM_DOMAIN,
          intakeSource: "timeflow_attachment",
          createdByUserId: userId,
        },
        data: { organizationId: currentOrgId },
      }),
    ]);

    let settingsAction: "none" | "moved" | "merged" = "none";

    if (sourceSettings && !targetSettings) {
      await tx.timeflowSettings.update({
        where: { organizationId_userId: { organizationId: sourceOrgId, userId } },
        data: { organizationId: currentOrgId },
      });
      settingsAction = "moved";
    } else if (sourceSettings && targetSettings) {
      await tx.timeflowSettings.update({
        where: { organizationId_userId: { organizationId: currentOrgId, userId } },
        data: {
          businessName: sourceSettings.businessName || targetSettings.businessName,
          defaultClientId: sourceSettings.defaultClientId || targetSettings.defaultClientId,
          invoiceFrequency: sourceSettings.invoiceFrequency || targetSettings.invoiceFrequency,
          payPeriodFrequency: sourceSettings.payPeriodFrequency || targetSettings.payPeriodFrequency,
          payPeriodStartDate: sourceSettings.payPeriodStartDate || targetSettings.payPeriodStartDate,
          invoiceNotes: sourceSettings.invoiceNotes || targetSettings.invoiceNotes,
          paymentInstructions: sourceSettings.paymentInstructions || targetSettings.paymentInstructions,
          invoiceLogoDataUrl: sourceSettings.invoiceLogoDataUrl || targetSettings.invoiceLogoDataUrl,
          invoiceBannerDataUrl: sourceSettings.invoiceBannerDataUrl || targetSettings.invoiceBannerDataUrl,
          companyViewerAccess: sourceSettings.companyViewerAccess || targetSettings.companyViewerAccess,
          emailTemplate: sourceSettings.emailTemplate || targetSettings.emailTemplate,
          periodWeekStartsOn: sourceSettings.periodWeekStartsOn || targetSettings.periodWeekStartsOn,
          periodTargetHours: sourceSettings.periodTargetHours || targetSettings.periodTargetHours,
          periodTargetEarnings: sourceSettings.periodTargetEarnings || targetSettings.periodTargetEarnings,
        },
      });
      await tx.timeflowSettings.delete({
        where: { organizationId_userId: { organizationId: sourceOrgId, userId } },
      });
      settingsAction = "merged";
    }

    return {
      clientsMoved: clientsMoved.count,
      projectsMoved: projectsMoved.count,
      timeEntriesMoved: entriesMoved.count,
      invoicesMoved: invoicesMoved.count,
      projectBillsMoved: projectBillsMoved.count,
      documentsMoved: documentsMoved.count,
      settingsAction,
    };
  });

  logger.warn("[timeflow] org relink executed", {
    email,
    userId,
    sourceOrgId,
    targetOrgId: currentOrgId,
    ...result,
  });

  res.json({
    ok: true,
    email,
    userId,
    sourceOrgId,
    targetOrgId: currentOrgId,
    ...result,
  });
});

// ─── Documents (centralized attachment metadata) ────────────────────────────

router.get("/documents", async (req, res) => {
  const { userId, organizationId, email } = getUser(req);
  const query = req.query;
  const entityType = typeof query.entityType === "string" ? query.entityType : undefined;
  const entityId = typeof query.entityId === "string" ? query.entityId : undefined;
  const includeArchived = query.includeArchived === "true";

  if (!isTimeflowEntityType(entityType)) {
    res.status(400).json({ error: "entityType must be 'client', 'project', 'expense', or 'invoice'" });
    return;
  }

  if (entityId) {
    const allowed = await assertTimeflowEntityAccess(entityType, entityId, { organizationId, userId });
    if (!allowed) {
      res.status(404).json({ error: `${entityType} not found` });
      return;
    }
  }

  const store = prisma as unknown as {
    document: {
      findMany: (args: Record<string, unknown>) => Promise<Array<{
        id: string;
        title: string;
        originalFileName: string | null;
        author: string;
        createdAt: Date;
        updatedAt: Date;
        status: string | null;
        mimeType: string | null;
        fileSize: number | null;
        filePath: string | null;
        sourceReference: string | null;
        extractedMetadata: unknown;
      }>>;
    };
  };

  const where: Record<string, unknown> = {
    organizationId,
    programDomain: TIMEFLOW_PROGRAM_DOMAIN,
    intakeSource: "timeflow_attachment",
    sourceReference: entityId
      ? buildEntitySourceReference(entityType, entityId)
      : { startsWith: `timeflow:${entityType}:` },
  };

  if (!includeArchived) {
    where.status = "active";
  }

  const docs = await store.document.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });

  res.json({
    documents: docs
      .map((doc) => toTimeflowDocumentRecord(doc))
      .filter((doc) => doc.entityType === entityType),
    scope: { organizationId, userId, programDomain: TIMEFLOW_PROGRAM_DOMAIN, email },
  });
});

router.post("/documents", async (req, res) => {
  const { userId, organizationId, email } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};

  const entityType = body.entityType;
  const entityId = asString(body.entityId).trim();
  const title = asString(body.title).trim();
  const originalFilename = asString(body.originalFilename).trim();
  const note = asString(body.note).trim();
  const mimeType = asString(body.mimeType).trim() || "application/octet-stream";
  const sizeBytes = asNumber(body.sizeBytes);
  const storageKey = asString(body.storageKey).trim();
  const uploadedBy = asString(body.uploadedBy).trim() || email;
  const uploadedAt = asString(body.uploadedAt).trim() || new Date().toISOString();

  if (!isTimeflowEntityType(entityType)) {
    res.status(400).json({ error: "entityType must be 'client', 'project', 'expense', or 'invoice'" });
    return;
  }
  if (!entityId) {
    res.status(400).json({ error: "entityId is required" });
    return;
  }
  if (!storageKey) {
    res.status(400).json({ error: "storageKey is required" });
    return;
  }
  if (!originalFilename) {
    res.status(400).json({ error: "originalFilename is required" });
    return;
  }

  const allowed = await assertTimeflowEntityAccess(entityType, entityId, { organizationId, userId });
  if (!allowed) {
    res.status(404).json({ error: `${entityType} not found` });
    return;
  }

  const payload = createDocumentPayload({
    title: title || undefined,
    description: note,
    author: uploadedBy,
    uploaderName: uploadedBy,
    category: "Timeflow",
    type: `${entityType}_attachment`,
    intakeSource: "timeflow_attachment",
    sourceReference: buildEntitySourceReference(entityType, entityId),
    fileMeta: {
      originalFileName: originalFilename,
      mimeType,
      fileSize: sizeBytes,
      fileUrl: storageKey,
      filePath: storageKey,
    },
  });

  const metadata = {
    ...(isRecord(payload.extractedMetadata) ? payload.extractedMetadata : {}),
    timeflow: {
      entityType,
      entityId,
      note: note || undefined,
      status: "active",
      storageKey,
      uploadedBy,
      uploadedByUserId: userId,
      uploadedAt,
    },
  };

  const store = prisma as unknown as {
    document: {
      create: (args: Record<string, unknown>) => Promise<{
        id: string;
        title: string;
        originalFileName: string | null;
        author: string;
        createdAt: Date;
        updatedAt: Date;
        status: string | null;
        mimeType: string | null;
        fileSize: number | null;
        filePath: string | null;
        sourceReference: string | null;
        extractedMetadata: unknown;
      }>;
    };
  };

  const created = await store.document.create({
    data: {
      ...payload,
      organizationId,
      programDomain: TIMEFLOW_PROGRAM_DOMAIN,
      createdByUserId: userId,
      uploadedById: userId,
      extractedMetadata: metadata,
      status: "active",
      processingStatus: "stored",
      ocrStatus: "not_needed",
      needsReview: false,
      review: { required: false },
      extraction: { status: "complete", method: "upload", extractedAt: new Date().toISOString() },
      aiSummary: "",
    },
  });

  res.status(201).json({ document: toTimeflowDocumentRecord(created) });
});

router.patch("/documents/:id", async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const body = isRecord(req.body) ? req.body : {};

  const store = prisma as unknown as {
    document: {
      findFirst: (args: Record<string, unknown>) => Promise<{
        id: string;
        title: string;
        originalFileName: string | null;
        author: string;
        createdAt: Date;
        updatedAt: Date;
        status: string | null;
        mimeType: string | null;
        fileSize: number | null;
        filePath: string | null;
        sourceReference: string | null;
        extractedMetadata: unknown;
      } | null>;
      update: (args: Record<string, unknown>) => Promise<{
        id: string;
        title: string;
        originalFileName: string | null;
        author: string;
        createdAt: Date;
        updatedAt: Date;
        status: string | null;
        mimeType: string | null;
        fileSize: number | null;
        filePath: string | null;
        sourceReference: string | null;
        extractedMetadata: unknown;
      }>;
    };
  };

  const current = await store.document.findFirst({
    where: {
      id,
      organizationId,
      programDomain: TIMEFLOW_PROGRAM_DOMAIN,
      intakeSource: "timeflow_attachment",
    },
  });

  if (!current) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const entity = parseEntitySourceReference(current.sourceReference);
  if (!entity) {
    res.status(400).json({ error: "Document source reference is invalid" });
    return;
  }

  const allowed = await assertTimeflowEntityAccess(entity.entityType, entity.entityId, { organizationId, userId });
  if (!allowed) {
    res.status(404).json({ error: `${entity.entityType} not found` });
    return;
  }

  const metadata = isRecord(current.extractedMetadata) ? current.extractedMetadata : {};
  const timeflowMeta = isRecord(metadata.timeflow) ? metadata.timeflow : {};

  const nextTitle = "title" in body ? asString(body.title).trim() : current.title;
  const nextNote = "note" in body ? asString(body.note).trim() : asString(timeflowMeta.note);
  const nextStatus = "status" in body ? asAttachmentStatus(body.status) : asAttachmentStatus(timeflowMeta.status || current.status);

  const updated = await store.document.update({
    where: { id },
    data: {
      title: nextTitle || current.title,
      status: nextStatus,
      extractedMetadata: {
        ...metadata,
        timeflow: {
          ...timeflowMeta,
          entityType: entity.entityType,
          entityId: entity.entityId,
          note: nextNote || undefined,
          status: nextStatus,
          storageKey: asString(timeflowMeta.storageKey) || current.filePath || undefined,
          uploadedBy: asString(timeflowMeta.uploadedBy) || current.author,
          uploadedAt: asString(timeflowMeta.uploadedAt) || current.createdAt.toISOString(),
          uploadedByUserId: asString(timeflowMeta.uploadedByUserId) || userId,
        },
      },
    },
  });

  res.json({ document: toTimeflowDocumentRecord(updated) });
});

router.patch("/documents/:id/archive", async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;

  const store = prisma as unknown as {
    document: {
      findFirst: (args: Record<string, unknown>) => Promise<{
        id: string;
        sourceReference: string | null;
      } | null>;
      update: (args: Record<string, unknown>) => Promise<{
        id: string;
        title: string;
        originalFileName: string | null;
        author: string;
        createdAt: Date;
        updatedAt: Date;
        status: string | null;
        mimeType: string | null;
        fileSize: number | null;
        filePath: string | null;
        sourceReference: string | null;
        extractedMetadata: unknown;
      }>;
    };
  };

  const current = await store.document.findFirst({
    where: {
      id,
      organizationId,
      programDomain: TIMEFLOW_PROGRAM_DOMAIN,
      intakeSource: "timeflow_attachment",
    },
  });

  if (!current) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const entity = parseEntitySourceReference(current.sourceReference);
  if (!entity) {
    res.status(400).json({ error: "Document source reference is invalid" });
    return;
  }

  const allowed = await assertTimeflowEntityAccess(entity.entityType, entity.entityId, { organizationId, userId });
  if (!allowed) {
    res.status(404).json({ error: `${entity.entityType} not found` });
    return;
  }

  const updated = await store.document.update({
    where: { id },
    data: {
      status: "archived",
    },
  });

  res.json({ document: toTimeflowDocumentRecord(updated) });
});

router.post("/documents/upload", upload.single("file"), async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = req.body as Record<string, unknown>;
  const entityType = asString(body?.entityType).trim();
  const entityId = asString(body?.entityId).trim();

  if (!req.file) {
    res.status(400).json({ error: "File is required" });
    return;
  }

  if (req.file.size > TIMEFLOW_MAX_UPLOAD_BYTES) {
    res.status(413).json({ error: `File too large. Maximum size is ${Math.round(TIMEFLOW_MAX_UPLOAD_BYTES / (1024 * 1024))}MB.` });
    return;
  }

  if (entityType && !isTimeflowEntityType(entityType)) {
    res.status(400).json({ error: "entityType must be 'client', 'project', 'expense', or 'invoice'" });
    return;
  }

  const normalizedEntityType = isTimeflowEntityType(entityType) ? entityType : undefined;

  if (entityType && !entityId) {
    res.status(400).json({ error: "entityId is required when entityType is provided" });
    return;
  }

  if (normalizedEntityType && entityId) {
    const allowed = await assertTimeflowEntityAccess(normalizedEntityType, entityId, { organizationId, userId });
    if (!allowed) {
      res.status(404).json({ error: `${normalizedEntityType} not found` });
      return;
    }
  }

  const safeFilename = makeSafeFilename(req.file.originalname);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (isR2Configured()) {
    const key = buildTimeflowR2Key({
      organizationId,
      entityType: normalizedEntityType,
      entityId: entityId || undefined,
      safeFilename,
      stamp,
    });
    const result = await uploadToR2(key, req.file.buffer, req.file.mimetype || "application/octet-stream");

    res.status(201).json({
      key: result.key,
      originalFilename: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      entityType: entityType || null,
      entityId: entityId || null,
      storage: "r2",
    });
    return;
  }

  // Local fallback for development environments without R2.
  const localDir = path.join(
    UPLOAD_DIR,
    "timeflow",
    organizationId,
    entityType || "document",
    entityId || "unscoped",
  );
  await fsPromises.mkdir(localDir, { recursive: true });
  const localPath = path.join(localDir, `${stamp}-${safeFilename}`);
  await fsPromises.writeFile(localPath, req.file.buffer);

  res.status(201).json({
    key: localPath,
    originalFilename: req.file.originalname,
    mimeType: req.file.mimetype,
    sizeBytes: req.file.size,
    entityType: entityType || null,
    entityId: entityId || null,
    storage: "local",
  });
});

router.get("/documents/:id/view-url", async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;

  const store = prisma as unknown as {
    document: {
      findFirst: (args: Record<string, unknown>) => Promise<{
        id: string;
        status: string | null;
        filePath: string | null;
        sourceReference: string | null;
        extractedMetadata: unknown;
      } | null>;
    };
  };

  const doc = await store.document.findFirst({
    where: {
      id,
      organizationId,
      programDomain: TIMEFLOW_PROGRAM_DOMAIN,
      intakeSource: "timeflow_attachment",
    },
  });

  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const entity = parseEntitySourceReference(doc.sourceReference);
  if (!entity) {
    res.status(400).json({ error: "Document source reference is invalid" });
    return;
  }

  const allowed = await assertTimeflowEntityAccess(entity.entityType, entity.entityId, { organizationId, userId });
  if (!allowed) {
    res.status(404).json({ error: `${entity.entityType} not found` });
    return;
  }

  if (doc.status === "archived") {
    res.status(410).json({ error: "Document is archived" });
    return;
  }

  const metadata = isRecord(doc.extractedMetadata) ? doc.extractedMetadata : {};
  const timeflowMeta = isRecord(metadata.timeflow) ? metadata.timeflow : {};
  const storageKey = asString(timeflowMeta.storageKey) || doc.filePath || "";
  if (!storageKey) {
    res.status(404).json({ error: "Document storage key is missing" });
    return;
  }

  if (isR2Configured() && isR2Key(storageKey)) {
    const signedUrl = await getR2SignedDownloadUrl(storageKey, {
      expiresIn: 900,
      disposition: "inline",
    });
    if (!signedUrl) {
      res.status(404).json({ error: "Document file was not found in storage" });
      return;
    }

    res.json({ url: signedUrl, expiresIn: 900 });
    return;
  }

  res.json({ url: `/api/timeflow/documents/${encodeURIComponent(id)}/download`, expiresIn: 900 });
});

router.get("/documents/:id/download-url", async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;

  const store = prisma as unknown as {
    document: {
      findFirst: (args: Record<string, unknown>) => Promise<{
        id: string;
        status: string | null;
        sourceReference: string | null;
      } | null>;
    };
  };

  const doc = await store.document.findFirst({
    where: {
      id,
      organizationId,
      programDomain: TIMEFLOW_PROGRAM_DOMAIN,
      intakeSource: "timeflow_attachment",
    },
  });

  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const entity = parseEntitySourceReference(doc.sourceReference);
  if (!entity) {
    res.status(400).json({ error: "Document source reference is invalid" });
    return;
  }

  const allowed = await assertTimeflowEntityAccess(entity.entityType, entity.entityId, { organizationId, userId });
  if (!allowed) {
    res.status(404).json({ error: `${entity.entityType} not found` });
    return;
  }

  if (doc.status === "archived") {
    res.status(410).json({ error: "Document is archived" });
    return;
  }

  res.json({ url: `/api/timeflow/documents/${encodeURIComponent(id)}/download`, expiresIn: 900 });
});

router.get("/documents/:id/download", async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;

  const store = prisma as unknown as {
    document: {
      findFirst: (args: Record<string, unknown>) => Promise<{
        id: string;
        title: string;
        originalFileName: string | null;
        author: string;
        createdAt: Date;
        updatedAt: Date;
        status: string | null;
        mimeType: string | null;
        fileSize: number | null;
        filePath: string | null;
        sourceReference: string | null;
        extractedMetadata: unknown;
      } | null>;
    };
  };

  const doc = await store.document.findFirst({
    where: {
      id,
      organizationId,
      programDomain: TIMEFLOW_PROGRAM_DOMAIN,
      intakeSource: "timeflow_attachment",
    },
  });

  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const entity = parseEntitySourceReference(doc.sourceReference);
  if (!entity) {
    res.status(400).json({ error: "Document source reference is invalid" });
    return;
  }

  const allowed = await assertTimeflowEntityAccess(entity.entityType, entity.entityId, {
    organizationId,
    userId,
  });
  if (!allowed) {
    res.status(404).json({ error: `${entity.entityType} not found` });
    return;
  }

  if (doc.status === "archived") {
    res.status(410).json({ error: "Document is archived" });
    return;
  }

  const metadata = isRecord(doc.extractedMetadata) ? doc.extractedMetadata : {};
  const timeflowMeta = isRecord(metadata.timeflow) ? metadata.timeflow : {};
  const storageKey = asString(timeflowMeta.storageKey) || doc.filePath || "";

  if (!storageKey) {
    res.status(404).json({ error: "Document storage key is missing" });
    return;
  }

  if (isR2Configured() && isR2Key(storageKey)) {
    const signedUrl = await getR2SignedDownloadUrl(storageKey, {
      expiresIn: 900,
      disposition: "inline",
    });
    if (!signedUrl) {
      res.status(404).json({ error: "Document file was not found in storage" });
      return;
    }
    res.redirect(signedUrl);
    return;
  }

  if (!path.isAbsolute(storageKey)) {
    res.status(404).json({ error: "Document file is unavailable in this environment" });
    return;
  }

  if (!fs.existsSync(storageKey)) {
    res.status(404).json({ error: "Document file not found on disk" });
    return;
  }

  res.download(storageKey, doc.originalFileName || "document");
});

// ─── Settings ────────────────────────────────────────────────────────────────

router.get("/settings", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    timeflowSettings: {
      findUnique: (args: { where: Record<string, unknown> }) => Promise<Record<string, unknown> | null>;
      upsert: (args: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) => Promise<Record<string, unknown>>;
    };
  };

  const settings = await store.timeflowSettings.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });

  if (!settings) {
    const created = await store.timeflowSettings.upsert({
      where: { organizationId_userId: { organizationId, userId } },
      create: {
        organizationId,
        userId,
        businessName: "",
        invoiceFrequency: "monthly",
        payPeriodFrequency: "monthly",
        periodWeekStartsOn: 1,
        periodTargetHours: 0,
        periodTargetEarnings: 0,
      },
      update: {},
    });
    res.json(created);
    return;
  }

  res.json(settings);
});

router.put("/settings", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    timeflowSettings: {
      upsert: (args: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) => Promise<Record<string, unknown>>;
    };
  };

  const data: Record<string, unknown> = {};
  if (typeof body.businessName === "string") data.businessName = body.businessName;
  if ("defaultClientId" in body) data.defaultClientId = typeof body.defaultClientId === "string" ? body.defaultClientId : null;
  if (typeof body.invoiceFrequency === "string") data.invoiceFrequency = body.invoiceFrequency;
  if (typeof body.payPeriodFrequency === "string") data.payPeriodFrequency = body.payPeriodFrequency;
  if ("payPeriodStartDate" in body) data.payPeriodStartDate = typeof body.payPeriodStartDate === "string" ? body.payPeriodStartDate : null;
  if (typeof body.invoiceNotes === "string") data.invoiceNotes = body.invoiceNotes;
  if (typeof body.paymentInstructions === "string") data.paymentInstructions = body.paymentInstructions;
  if ("invoiceLogoDataUrl" in body) data.invoiceLogoDataUrl = typeof body.invoiceLogoDataUrl === "string" ? body.invoiceLogoDataUrl : null;
  if ("invoiceBannerDataUrl" in body) data.invoiceBannerDataUrl = typeof body.invoiceBannerDataUrl === "string" ? body.invoiceBannerDataUrl : null;
  if (typeof body.companyViewerAccess === "boolean") data.companyViewerAccess = body.companyViewerAccess;
  if (typeof body.emailTemplate === "string") data.emailTemplate = body.emailTemplate;
  if (typeof body.periodWeekStartsOn === "number") data.periodWeekStartsOn = body.periodWeekStartsOn;
  if (typeof body.periodTargetHours === "number") data.periodTargetHours = body.periodTargetHours;
  if (typeof body.periodTargetEarnings === "number") data.periodTargetEarnings = body.periodTargetEarnings;

  const settings = await store.timeflowSettings.upsert({
    where: { organizationId_userId: { organizationId, userId } },
    create: { organizationId, userId, ...data },
    update: data,
  });

  res.json(settings);
});

// ─── Clients ──────────────────────────────────────────────────────────────────

router.get("/clients", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    timeflowClient: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };

  const clients = await store.timeflowClient.findMany({
    where: { organizationId, userId },
    orderBy: { name: "asc" },
  });
  res.json(clients);
});

router.post("/clients", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    timeflowClient: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };

  if (typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const client = await store.timeflowClient.create({
    data: {
      ...(typeof body.id === "string" && body.id.trim() ? { id: body.id.trim() } : {}),
      organizationId,
      userId,
      name: (body.name as string).trim(),
      contactName: typeof body.contactName === "string" ? body.contactName : null,
      contactEmail: typeof body.contactEmail === "string" ? body.contactEmail : null,
      contacts: Array.isArray(body.contacts) ? body.contacts : [],
      hourlyRate: typeof body.hourlyRate === "number" ? body.hourlyRate : null,
      companyViewerEnabled: body.companyViewerEnabled === true,
    },
  });

  res.status(201).json(client);
});

router.put("/clients/:id", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    timeflowClient: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.timeflowClient.findFirst({ where: { id, organizationId, userId } });
  if (!existing) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  const data: Record<string, unknown> = {};
  if (typeof body.name === "string") data.name = body.name.trim();
  if ("contactName" in body) data.contactName = typeof body.contactName === "string" ? body.contactName : null;
  if ("contactEmail" in body) data.contactEmail = typeof body.contactEmail === "string" ? body.contactEmail : null;
  if ("contacts" in body) data.contacts = Array.isArray(body.contacts) ? body.contacts : [];
  if ("hourlyRate" in body) data.hourlyRate = typeof body.hourlyRate === "number" ? body.hourlyRate : null;
  if (typeof body.companyViewerEnabled === "boolean") data.companyViewerEnabled = body.companyViewerEnabled;

  const updated = await store.timeflowClient.update({ where: { id }, data });
  res.json(updated);
});

router.delete("/clients/:id", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const store = prisma as unknown as {
    timeflowClient: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.timeflowClient.findFirst({ where: { id, organizationId, userId } });
  if (!existing) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  // Soft delete
  await store.timeflowClient.update({ where: { id }, data: { isActive: false } });
  res.status(204).send();
});

router.patch("/clients/:id/archive", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const store = prisma as unknown as {
    timeflowClient: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.timeflowClient.findFirst({ where: { id, organizationId, userId } });
  if (!existing) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  const updated = await store.timeflowClient.update({ where: { id }, data: { isActive: false } });
  res.json(updated);
});

router.patch("/clients/:id/restore", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const store = prisma as unknown as {
    timeflowClient: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.timeflowClient.findFirst({ where: { id, organizationId, userId } });
  if (!existing) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  const updated = await store.timeflowClient.update({ where: { id }, data: { isActive: true } });
  res.json(updated);
});

// ─── Projects ─────────────────────────────────────────────────────────────────

router.get("/projects", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { clientId } = req.query;
  const store = prisma as unknown as {
    timeflowProject: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };

  const where: Record<string, unknown> = { organizationId, userId };
  if (typeof clientId === "string") where.clientId = clientId;

  const projects = await store.timeflowProject.findMany({
    where,
    orderBy: { name: "asc" },
  });
  res.json(projects);
});

router.post("/projects", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    timeflowClient: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
    timeflowProject: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };

  if (typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (typeof body.clientId !== "string") {
    res.status(400).json({ error: "clientId is required" });
    return;
  }

  const client = await store.timeflowClient.findFirst({ where: { id: body.clientId, organizationId, userId } });
  if (!client) {
    res.status(400).json({ error: "Client not found" });
    return;
  }

  const project = await store.timeflowProject.create({
    data: {
      ...(typeof body.id === "string" && body.id.trim() ? { id: body.id.trim() } : {}),
      organizationId,
      userId,
      clientId: body.clientId as string,
      name: (body.name as string).trim(),
      status: typeof body.status === "string" ? body.status : "active",
      description: typeof body.description === "string" ? body.description : "",
      billingType: typeof body.billingType === "string" ? body.billingType : "hourly_uncapped",
      hourlyRate: typeof body.hourlyRate === "number" ? body.hourlyRate : 0,
      maxPayoutCap: typeof body.maxPayoutCap === "number" ? body.maxPayoutCap : 0,
      capHandling: typeof body.capHandling === "string" ? body.capHandling : "allow_overage",
      startDate: typeof body.startDate === "string" ? body.startDate : new Date().toISOString().split("T")[0],
      endDate: typeof body.endDate === "string" ? body.endDate : null,
      notes: typeof body.notes === "string" ? body.notes : "",
    },
  });

  res.status(201).json(project);
});

router.put("/projects/:id", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    timeflowProject: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.timeflowProject.findFirst({ where: { id, organizationId, userId } });
  if (!existing) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const data: Record<string, unknown> = {};
  if (typeof body.name === "string") data.name = body.name.trim();
  if (typeof body.status === "string") data.status = body.status;
  if (typeof body.description === "string") data.description = body.description;
  if (typeof body.billingType === "string") data.billingType = body.billingType;
  if (typeof body.hourlyRate === "number") data.hourlyRate = body.hourlyRate;
  if (typeof body.maxPayoutCap === "number") data.maxPayoutCap = body.maxPayoutCap;
  if (typeof body.capHandling === "string") data.capHandling = body.capHandling;
  if (typeof body.startDate === "string") data.startDate = body.startDate;
  if ("endDate" in body) data.endDate = typeof body.endDate === "string" ? body.endDate : null;
  if (typeof body.notes === "string") data.notes = body.notes;

  const updated = await store.timeflowProject.update({ where: { id }, data });
  res.json(updated);
});

router.delete("/projects/:id", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const store = prisma as unknown as {
    timeflowProject: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.timeflowProject.findFirst({ where: { id, organizationId, userId } });
  if (!existing) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  await store.timeflowProject.update({ where: { id }, data: { isActive: false } });
  res.status(204).send();
});

router.patch("/projects/:id/archive", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const store = prisma as unknown as {
    timeflowProject: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.timeflowProject.findFirst({ where: { id, organizationId, userId } });
  if (!existing) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const updated = await store.timeflowProject.update({ where: { id }, data: { isActive: false } });
  res.json(updated);
});

router.patch("/projects/:id/restore", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const store = prisma as unknown as {
    timeflowProject: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.timeflowProject.findFirst({ where: { id, organizationId, userId } });
  if (!existing) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const updated = await store.timeflowProject.update({ where: { id }, data: { isActive: true } });
  res.json(updated);
});

// ─── Time Entries ─────────────────────────────────────────────────────────────

router.get("/time-entries", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { clientId, projectId, workspaceId, invoiced, status, dateFrom, dateTo } = req.query;
  const store = prisma as unknown as {
    timeflowTimeEntry: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };

  const where: Record<string, unknown> = { organizationId, userId };
  if (typeof clientId === "string") where.clientId = clientId;
  if (typeof projectId === "string") where.projectId = projectId;
  if (typeof workspaceId === "string") where.workspaceId = workspaceId;
  if (invoiced === "true") where.invoiced = true;
  if (invoiced === "false") where.invoiced = false;
  if (typeof status === "string") where.status = status;
  if (typeof dateFrom === "string" || typeof dateTo === "string") {
    where.date = {};
    if (typeof dateFrom === "string") (where.date as Record<string, unknown>).gte = dateFrom;
    if (typeof dateTo === "string") (where.date as Record<string, unknown>).lte = dateTo;
  }

  const entries = await store.timeflowTimeEntry.findMany({
    where,
    orderBy: [{ date: "desc" }, { startTime: "desc" }],
  });
  res.json(entries);
});

router.post("/time-entries", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    timeflowTimeEntry: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };

  if (typeof body.clientId !== "string") {
    res.status(400).json({ error: "clientId is required" });
    return;
  }

  const entryType = body.entryType === "fixed" ? "fixed" : "time";
  const fixedAmount = entryType === "fixed"
    ? (typeof body.fixedAmount === "number" ? body.fixedAmount : 0)
    : null;
  const durationHours = entryType === "fixed"
    ? 0
    : (typeof body.durationHours === "number" ? body.durationHours : 0);
  const billingRate = entryType === "fixed"
    ? null
    : (typeof body.billingRate === "number" ? body.billingRate : null);
  const endTime = entryType === "fixed"
    ? null
    : (typeof body.endTime === "string" ? body.endTime : null);
  const timeType = body.timeType === "leave" || body.timeType === "manual" || body.timeType === "correction"
    ? body.timeType
    : "worked";
  const leaveType = timeType === "leave" && typeof body.leaveType === "string"
    ? body.leaveType
    : null;

  const entry = await store.timeflowTimeEntry.create({
    data: {
      ...(typeof body.id === "string" && body.id.trim() ? { id: body.id.trim() } : {}),
      organizationId,
      workspaceId: typeof body.workspaceId === "string" ? body.workspaceId : organizationId,
      userId,
      entryType,
      fixedAmount,
      clientId: body.clientId as string,
      projectId: typeof body.projectId === "string" ? body.projectId : null,
      date: typeof body.date === "string" ? body.date : new Date().toISOString().split("T")[0],
      startTime: typeof body.startTime === "string" ? body.startTime : "00:00",
      endTime,
      durationHours,
      billingRate,
      billable: body.billable !== false,
      invoiced: body.invoiced === true,
      invoiceId: typeof body.invoiceId === "string" ? body.invoiceId : null,
      notes: typeof body.notes === "string" ? body.notes : "",
      status: typeof body.status === "string" ? body.status : "completed",
      timeType,
      leaveType,
      sourceType: typeof body.sourceType === "string" ? body.sourceType : null,
      sourceRequestId: typeof body.sourceRequestId === "string" ? body.sourceRequestId : null,
    },
  });

  res.status(201).json(entry);
});

router.put("/time-entries/:id", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    timeflowTimeEntry: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.timeflowTimeEntry.findFirst({ where: { id, organizationId, userId } });
  if (!existing) {
    res.status(404).json({ error: "Time entry not found" });
    return;
  }

  const data: Record<string, unknown> = {};
  const effectiveEntryType = body.entryType === "fixed"
    ? "fixed"
    : body.entryType === "time"
      ? "time"
      : (existing.entryType === "fixed" ? "fixed" : "time");

  if (typeof body.clientId === "string") data.clientId = body.clientId;
  if (typeof body.workspaceId === "string") data.workspaceId = body.workspaceId;
  if ("projectId" in body) data.projectId = typeof body.projectId === "string" ? body.projectId : null;
  if (typeof body.date === "string") data.date = body.date;
  if (typeof body.startTime === "string") data.startTime = body.startTime;
  if ("entryType" in body) data.entryType = effectiveEntryType;
  if ("fixedAmount" in body) {
    data.fixedAmount = effectiveEntryType === "fixed" && typeof body.fixedAmount === "number"
      ? body.fixedAmount
      : null;
  }
  if ("endTime" in body) {
    data.endTime = effectiveEntryType === "fixed"
      ? null
      : (typeof body.endTime === "string" ? body.endTime : null);
  }
  if (typeof body.durationHours === "number") {
    data.durationHours = effectiveEntryType === "fixed" ? 0 : body.durationHours;
  }
  if ("billingRate" in body) {
    data.billingRate = effectiveEntryType === "fixed"
      ? null
      : (typeof body.billingRate === "number" ? body.billingRate : null);
  }
  if (typeof body.billable === "boolean") data.billable = body.billable;
  if (typeof body.invoiced === "boolean") data.invoiced = body.invoiced;
  if ("invoiceId" in body) data.invoiceId = typeof body.invoiceId === "string" ? body.invoiceId : null;
  if (typeof body.notes === "string") data.notes = body.notes;
  if (typeof body.status === "string") data.status = body.status;
  if (typeof body.timeType === "string") {
    data.timeType = body.timeType;
    data.leaveType = body.timeType === "leave" && typeof body.leaveType === "string"
      ? body.leaveType
      : null;
  } else if ("leaveType" in body) {
    data.leaveType = typeof body.leaveType === "string" ? body.leaveType : null;
  }
  if (typeof body.sourceType === "string") data.sourceType = body.sourceType;
  if ("sourceRequestId" in body) data.sourceRequestId = typeof body.sourceRequestId === "string" ? body.sourceRequestId : null;

  const updated = await store.timeflowTimeEntry.update({ where: { id }, data });
  res.json(updated);
});

router.delete("/time-entries/:id", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const store = prisma as unknown as {
    timeflowTimeEntry: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      delete: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.timeflowTimeEntry.findFirst({ where: { id, organizationId, userId } });
  if (!existing) {
    res.status(404).json({ error: "Time entry not found" });
    return;
  }

  await store.timeflowTimeEntry.delete({ where: { id } });
  res.status(204).send();
});

// Bulk update (for marking entries as invoiced, etc.)
router.patch("/time-entries/bulk", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    timeflowTimeEntry: {
      updateMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
    };
  };

  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    res.status(400).json({ error: "ids array is required" });
    return;
  }

  const data: Record<string, unknown> = {};
  if (typeof body.invoiced === "boolean") data.invoiced = body.invoiced;
  if (typeof body.invoiceId === "string" || body.invoiceId === null) data.invoiceId = body.invoiceId;
  if (typeof body.status === "string") data.status = body.status;

  const result = await store.timeflowTimeEntry.updateMany({
    where: { id: { in: body.ids as string[] }, organizationId, userId },
    data,
  });

  res.json({ updated: result.count });
});

// ─── Time-off requests ───────────────────────────────────────────────────────

router.get("/time-off-requests", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { status, workspaceId } = req.query;
  const store = prisma as unknown as {
    timeflowTimeOffRequest: {
      findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
    };
  };

  const where: Record<string, unknown> = { organizationId };
  if (typeof status === "string") where.status = status;
  if (typeof workspaceId === "string") where.workspaceId = workspaceId;
  if (typeof req.query.employeeId === "string") {
    where.employeeId = req.query.employeeId;
  } else {
    where.OR = [{ employeeId: userId }, { requestedBy: userId }];
  }

  const requests = await store.timeflowTimeOffRequest.findMany({
    where,
    orderBy: [{ requestedAt: "desc" }],
  });

  res.json(requests);
});

router.get("/time-off-requests/:id", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const store = prisma as unknown as {
    timeflowTimeOffRequest: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    };
  };

  const request = await store.timeflowTimeOffRequest.findFirst({
    where: {
      id,
      organizationId,
      OR: [{ employeeId: userId }, { requestedBy: userId }, { reviewedBy: userId }],
    },
  });

  if (!request) {
    res.status(404).json({ error: "Time-off request not found" });
    return;
  }

  res.json(request);
});

router.post("/time-off-requests", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId, role } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};

  const leaveType = typeof body.leaveType === "string" ? body.leaveType : "pto";
  const startDate = typeof body.startDate === "string" ? body.startDate : new Date().toISOString().slice(0, 10);
  const endDate = typeof body.endDate === "string" ? body.endDate : startDate;
  const hoursRequested = typeof body.hoursRequested === "number" ? body.hoursRequested : 0;
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : organizationId;
  const employeeId = typeof body.employeeId === "string" && body.employeeId.trim() ? body.employeeId : userId;
  const autoApprove = body.autoApprove === true && ["owner", "admin", "manager", "contractor"].includes(role);

  if (hoursRequested <= 0) {
    res.status(400).json({ error: "hoursRequested must be greater than 0" });
    return;
  }

  const store = prisma as unknown as {
    timeflowTimeOffRequest: {
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    timeflowTimeEntry: {
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    timeflowClient: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    };
  };

  const request = await store.timeflowTimeOffRequest.create({
    data: {
      organizationId,
      workspaceId,
      employeeId,
      leaveType,
      startDate,
      endDate,
      hoursRequested,
      status: autoApprove ? "approved" : "pending",
      reason: typeof body.reason === "string" ? body.reason : null,
      requestedBy: userId,
      requestedAt: new Date(),
      reviewedBy: autoApprove ? userId : null,
      reviewedAt: autoApprove ? new Date() : null,
      generatedTimeEntryIds: [],
    },
  });

  if (!autoApprove) {
    res.status(201).json({ request });
    return;
  }

  const fallbackClient = await store.timeflowClient.findFirst({
    where: { organizationId, userId: employeeId },
    orderBy: { createdAt: "asc" },
  });
  const clientId = typeof body.clientId === "string"
    ? body.clientId
    : (fallbackClient?.id as string | undefined);
  if (!clientId) {
    res.status(400).json({ error: "A valid clientId is required to generate leave entries." });
    return;
  }

  const generatedEntry = await store.timeflowTimeEntry.create({
    data: {
      organizationId,
      workspaceId,
      userId: employeeId,
      entryType: "time",
      fixedAmount: null,
      clientId,
      projectId: typeof body.projectId === "string" ? body.projectId : null,
      date: startDate,
      startTime: "09:00",
      endTime: "17:00",
      durationHours: hoursRequested,
      billingRate: null,
      billable: leaveType !== "unpaid",
      invoiced: false,
      invoiceId: null,
      notes: typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : `Time off request (${leaveType})`,
      status: "approved",
      timeType: "leave",
      leaveType,
      sourceType: "time_off_request",
      sourceRequestId: request.id,
    },
  });

  const finalizedRequest = await store.timeflowTimeOffRequest.update({
    where: { id: request.id },
    data: {
      generatedTimeEntryIds: [generatedEntry.id],
    },
  });

  res.status(201).json({ request: finalizedRequest, generatedEntries: [generatedEntry] });
});

router.patch("/time-off-requests/:id", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const body = isRecord(req.body) ? req.body : {};

  const store = prisma as unknown as {
    timeflowTimeOffRequest: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.timeflowTimeOffRequest.findFirst({ where: { id, organizationId } });
  if (!existing) {
    res.status(404).json({ error: "Time-off request not found" });
    return;
  }

  const data: Record<string, unknown> = {};
  if (typeof body.reason === "string") data.reason = body.reason;
  if (typeof body.reviewerNote === "string") data.reviewerNote = body.reviewerNote;
  if (typeof body.startDate === "string") data.startDate = body.startDate;
  if (typeof body.endDate === "string") data.endDate = body.endDate;
  if (typeof body.hoursRequested === "number" && body.hoursRequested > 0) data.hoursRequested = body.hoursRequested;
  data.updatedAt = new Date();

  const updated = await store.timeflowTimeOffRequest.update({ where: { id }, data });
  res.json(updated);
});

router.post("/time-off-requests/:id/approve", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const body = isRecord(req.body) ? req.body : {};

  const store = prisma as unknown as {
    timeflowTimeOffRequest: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    timeflowTimeEntry: {
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    timeflowClient: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    };
  };

  const existing = await store.timeflowTimeOffRequest.findFirst({ where: { id, organizationId } });
  if (!existing) {
    res.status(404).json({ error: "Time-off request not found" });
    return;
  }

  const requestRecord = existing as Record<string, unknown>;
  const existingStatus = typeof requestRecord.status === "string" ? requestRecord.status : "pending";
  if (existingStatus === "approved") {
    res.status(400).json({ error: "Time-off request is already approved" });
    return;
  }

  const leaveType = typeof requestRecord.leaveType === "string" ? requestRecord.leaveType : "pto";
  const employeeId = (requestRecord.employeeId as string) || userId;
  const fallbackClient = await store.timeflowClient.findFirst({
    where: { organizationId, userId: employeeId },
    orderBy: { createdAt: "asc" },
  });
  const clientId = typeof body.clientId === "string"
    ? body.clientId
    : (fallbackClient?.id as string | undefined);
  if (!clientId) {
    res.status(400).json({ error: "A valid clientId is required to approve and generate leave entries." });
    return;
  }

  const entry = await store.timeflowTimeEntry.create({
    data: {
      organizationId,
      workspaceId: (requestRecord.workspaceId as string) || organizationId,
      userId: employeeId,
      entryType: "time",
      fixedAmount: null,
      clientId,
      projectId: typeof body.projectId === "string" ? body.projectId : null,
      date: (requestRecord.startDate as string) || new Date().toISOString().slice(0, 10),
      startTime: "09:00",
      endTime: "17:00",
      durationHours: typeof requestRecord.hoursRequested === "number" ? requestRecord.hoursRequested : 0,
      billingRate: null,
      billable: leaveType !== "unpaid",
      invoiced: false,
      invoiceId: null,
      notes: typeof requestRecord.reason === "string" && requestRecord.reason.trim() ? requestRecord.reason : `Time off request (${leaveType})`,
      status: "approved",
      timeType: "leave",
      leaveType,
      sourceType: "time_off_request",
      sourceRequestId: id,
    },
  });

  const updatedRequest = await store.timeflowTimeOffRequest.update({
    where: { id },
    data: {
      status: "approved",
      reviewedBy: userId,
      reviewedAt: new Date(),
      reviewerNote: typeof body.reviewerNote === "string" ? body.reviewerNote : null,
      generatedTimeEntryIds: [entry.id],
    },
  });

  res.json({ request: updatedRequest, generatedEntries: [entry] });
});

router.post("/time-off-requests/:id/deny", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    timeflowTimeOffRequest: {
      updateMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    };
  };

  await store.timeflowTimeOffRequest.updateMany({
    where: { id, organizationId },
    data: {
      status: "denied",
      reviewedBy: userId,
      reviewedAt: new Date(),
      reviewerNote: typeof body.reviewerNote === "string" ? body.reviewerNote : null,
    },
  });

  const updated = await store.timeflowTimeOffRequest.findFirst({ where: { id, organizationId } });
  if (!updated) {
    res.status(404).json({ error: "Time-off request not found" });
    return;
  }
  res.json(updated);
});

router.post("/time-off-requests/:id/cancel", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const store = prisma as unknown as {
    timeflowTimeOffRequest: {
      updateMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    };
  };

  await store.timeflowTimeOffRequest.updateMany({
    where: {
      id,
      organizationId,
      OR: [{ requestedBy: userId }, { employeeId: userId }],
    },
    data: { status: "cancelled" },
  });

  const updated = await store.timeflowTimeOffRequest.findFirst({ where: { id, organizationId } });
  if (!updated) {
    res.status(404).json({ error: "Time-off request not found" });
    return;
  }
  res.json(updated);
});

// ─── Export helpers ─────────────────────────────────────────────────────────

router.get("/exports/pay-period-summary", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { startDate, endDate, workspaceId } = req.query;
  if (typeof startDate !== "string" || typeof endDate !== "string") {
    res.status(400).json({ error: "startDate and endDate are required" });
    return;
  }

  const store = prisma as unknown as {
    timeflowTimeEntry: {
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    };
  };

  const where: Record<string, unknown> = {
    organizationId,
    userId,
    date: {
      gte: startDate,
      lte: endDate,
    },
  };
  if (typeof workspaceId === "string") where.workspaceId = workspaceId;

  const entries = await store.timeflowTimeEntry.findMany({ where });
  const totalHours = entries.reduce((sum, entry) => sum + (typeof entry.durationHours === "number" ? entry.durationHours : 0), 0);
  const byStatus = entries.reduce<Record<string, number>>((acc, entry) => {
    const status = typeof entry.status === "string" ? entry.status : "unknown";
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});

  res.json({
    startDate,
    endDate,
    workspaceId: typeof workspaceId === "string" ? workspaceId : null,
    totalEntries: entries.length,
    totalHours: Number(totalHours.toFixed(2)),
    byStatus,
  });
});

router.get("/exports/pay-period-preview", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { startDate, endDate, workspaceId } = req.query;
  if (typeof startDate !== "string" || typeof endDate !== "string") {
    res.status(400).json({ error: "startDate and endDate are required" });
    return;
  }

  const store = prisma as unknown as {
    timeflowTimeEntry: {
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    };
  };

  const where: Record<string, unknown> = {
    organizationId,
    userId,
    date: {
      gte: startDate,
      lte: endDate,
    },
  };
  if (typeof workspaceId === "string") where.workspaceId = workspaceId;

  const entries = await store.timeflowTimeEntry.findMany({
    where,
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
  });

  res.json({ entries });
});

router.post("/exports/repair-workspace-scope", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};

  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : organizationId;
  const startDate = typeof body.startDate === "string" ? body.startDate : undefined;
  const endDate = typeof body.endDate === "string" ? body.endDate : undefined;

  const store = prisma as unknown as {
    timeflowTimeEntry: {
      updateMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
    };
  };

  const where: Record<string, unknown> = {
    organizationId,
    userId,
    OR: [{ workspaceId: null }, { workspaceId: "" }],
  };
  if (startDate || endDate) {
    where.date = {};
    if (startDate) (where.date as Record<string, unknown>).gte = startDate;
    if (endDate) (where.date as Record<string, unknown>).lte = endDate;
  }

  const result = await store.timeflowTimeEntry.updateMany({
    where,
    data: {
      workspaceId,
    },
  });

  res.json({ repaired: result.count });
});

router.post("/exports/create", requireTimeflowAuth, async (req, res) => {
  const { userId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  res.status(201).json({
    exportId: `exp-${Math.random().toString(36).slice(2, 10)}`,
    createdBy: userId,
    createdAt: new Date().toISOString(),
    payload: body,
  });
});

// ─── Expenses ────────────────────────────────────────────────────────────────

router.get("/expenses", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { clientId, status, invoiceId } = req.query;
  const store = prisma as unknown as {
    timeflowExpense: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };

  const where: Record<string, unknown> = { organizationId, userId };
  if (typeof clientId === "string") where.clientId = clientId;
  if (typeof status === "string") where.status = status;
  if (typeof invoiceId === "string") where.invoiceId = invoiceId;

  const expenses = await store.timeflowExpense.findMany({
    where,
    orderBy: { date: "desc" },
  });

  res.json(expenses);
});

router.post("/expenses", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    timeflowExpense: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };

  if (typeof body.date !== "string") {
    res.status(400).json({ error: "date is required" });
    return;
  }

  const expense = await store.timeflowExpense.create({
    data: {
      ...(typeof body.id === "string" && body.id.trim() ? { id: body.id.trim() } : {}),
      organizationId,
      userId,
      amount: typeof body.amount === "number" ? body.amount : 0,
      category: typeof body.category === "string" ? body.category : "other",
      billableToClient: body.billableToClient !== false,
      billTo: typeof body.billTo === "string" ? body.billTo : "client",
      clientId: typeof body.clientId === "string" ? body.clientId : null,
      date: body.date,
      description: typeof body.description === "string" ? body.description : "",
      excludedFromPayPeriod: body.excludedFromPayPeriod === true,
      includedInPayPeriod: body.includedInPayPeriod === true,
      invoiceId: typeof body.invoiceId === "string" ? body.invoiceId : null,
      notes: typeof body.notes === "string" ? body.notes : "",
      projectId: typeof body.projectId === "string" ? body.projectId : null,
      receiptAttached: body.receiptAttached === true,
      status: typeof body.status === "string" ? body.status : "billable",
      vendor: typeof body.vendor === "string" ? body.vendor : null,
    },
  });

  res.status(201).json(expense);
});

router.put("/expenses/:id", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    timeflowExpense: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.timeflowExpense.findFirst({ where: { id, organizationId, userId } });
  if (!existing) {
    res.status(404).json({ error: "Expense not found" });
    return;
  }

  const data: Record<string, unknown> = {};
  if (typeof body.amount === "number") data.amount = body.amount;
  if (typeof body.category === "string") data.category = body.category;
  if (typeof body.billableToClient === "boolean") data.billableToClient = body.billableToClient;
  if (typeof body.billTo === "string") data.billTo = body.billTo;
  if ("clientId" in body) data.clientId = typeof body.clientId === "string" ? body.clientId : null;
  if (typeof body.date === "string") data.date = body.date;
  if (typeof body.description === "string") data.description = body.description;
  if (typeof body.excludedFromPayPeriod === "boolean") data.excludedFromPayPeriod = body.excludedFromPayPeriod;
  if (typeof body.includedInPayPeriod === "boolean") data.includedInPayPeriod = body.includedInPayPeriod;
  if ("invoiceId" in body) data.invoiceId = typeof body.invoiceId === "string" ? body.invoiceId : null;
  if (typeof body.notes === "string") data.notes = body.notes;
  if ("projectId" in body) data.projectId = typeof body.projectId === "string" ? body.projectId : null;
  if (typeof body.receiptAttached === "boolean") data.receiptAttached = body.receiptAttached;
  if (typeof body.status === "string") data.status = body.status;
  if ("vendor" in body) data.vendor = typeof body.vendor === "string" ? body.vendor : null;

  const updated = await store.timeflowExpense.update({ where: { id }, data });
  res.json(updated);
});

router.delete("/expenses/:id", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const store = prisma as unknown as {
    timeflowExpense: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      delete: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.timeflowExpense.findFirst({ where: { id, organizationId, userId } });
  if (!existing) {
    res.status(404).json({ error: "Expense not found" });
    return;
  }

  await store.timeflowExpense.delete({ where: { id } });
  res.status(204).send();
});

// ─── Invoices ─────────────────────────────────────────────────────────────────

router.get("/invoices", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { clientId, status } = req.query;
  const store = prisma as unknown as {
    timeflowInvoice: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };

  const where: Record<string, unknown> = { organizationId, userId };
  if (typeof clientId === "string") where.clientId = clientId;
  if (typeof status === "string") where.status = status;

  const invoices = await store.timeflowInvoice.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });
  res.json(invoices);
});

router.get("/invoices/:id", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const store = prisma as unknown as {
    timeflowInvoice: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  };

  const invoice = await store.timeflowInvoice.findFirst({ where: { id, organizationId, userId } });
  if (!invoice) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  res.json(invoice);
});

router.post("/invoices", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    timeflowInvoice: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };

  if (typeof body.clientId !== "string") {
    res.status(400).json({ error: "clientId is required" });
    return;
  }

  const invoice = await store.timeflowInvoice.create({
    data: {
      ...(typeof body.id === "string" && body.id.trim() ? { id: body.id.trim() } : {}),
      organizationId,
      userId,
      clientId: body.clientId as string,
      periodStart: typeof body.periodStart === "string" ? body.periodStart : "",
      periodEnd: typeof body.periodEnd === "string" ? body.periodEnd : "",
      billingMode: typeof body.billingMode === "string" ? body.billingMode : "outstanding",
      rangeStart: typeof body.rangeStart === "string" ? body.rangeStart : null,
      rangeEnd: typeof body.rangeEnd === "string" ? body.rangeEnd : null,
      grouping: typeof body.grouping === "string" ? body.grouping : "none",
      dueDate: typeof body.dueDate === "string" ? body.dueDate : "",
      entryIds: Array.isArray(body.entryIds) ? body.entryIds : [],
      timeEntryIds: Array.isArray(body.timeEntryIds) ? body.timeEntryIds : [],
      lineItems: Array.isArray(body.lineItems) ? body.lineItems : [],
      projectIds: Array.isArray(body.projectIds) ? body.projectIds : [],
      totalHours: typeof body.totalHours === "number" ? body.totalHours : 0,
      hourlyRate: typeof body.hourlyRate === "number" ? body.hourlyRate : 0,
      subtotal: typeof body.subtotal === "number" ? body.subtotal : 0,
      taxRate: typeof body.taxRate === "number" ? body.taxRate : 0,
      taxAmount: typeof body.taxAmount === "number" ? body.taxAmount : 0,
      totalAmount: typeof body.totalAmount === "number" ? body.totalAmount : 0,
      hasMixedRates: body.hasMixedRates === true,
      status: typeof body.status === "string" ? body.status : "draft",
    },
  });

  res.status(201).json(invoice);
});

router.put("/invoices/:id", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    timeflowInvoice: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.timeflowInvoice.findFirst({ where: { id, organizationId, userId } });
  if (!existing) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }

  const data: Record<string, unknown> = {};
  const fields = [
    "periodStart", "periodEnd", "billingMode", "rangeStart", "rangeEnd",
    "grouping", "dueDate", "totalHours", "hourlyRate", "subtotal",
    "taxRate", "taxAmount", "totalAmount", "status",
  ] as const;

  for (const field of fields) {
    if (field in body) data[field] = body[field];
  }
  if ("entryIds" in body && Array.isArray(body.entryIds)) data.entryIds = body.entryIds;
  if ("timeEntryIds" in body && Array.isArray(body.timeEntryIds)) data.timeEntryIds = body.timeEntryIds;
  if ("lineItems" in body && Array.isArray(body.lineItems)) data.lineItems = body.lineItems;
  if ("projectIds" in body && Array.isArray(body.projectIds)) data.projectIds = body.projectIds;
  if (typeof body.hasMixedRates === "boolean") data.hasMixedRates = body.hasMixedRates;
  if (body.status === "issued") data.issuedAt = new Date();
  if (body.status === "paid") data.paidAt = new Date();

  const updated = await store.timeflowInvoice.update({ where: { id }, data });
  res.json(updated);
});

router.delete("/invoices/:id", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const store = prisma as unknown as {
    timeflowInvoice: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      delete: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.timeflowInvoice.findFirst({ where: { id, organizationId, userId } });
  if (!existing) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }

  await store.timeflowInvoice.delete({ where: { id } });
  res.status(204).send();
});

// ─── Project Bills ────────────────────────────────────────────────────────────

router.get("/project-bills", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { clientId, projectId, status } = req.query;
  const store = prisma as unknown as {
    timeflowProjectBill: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };

  const where: Record<string, unknown> = { organizationId, userId };
  if (typeof clientId === "string") where.clientId = clientId;
  if (typeof projectId === "string") where.projectId = projectId;
  if (typeof status === "string") where.status = status;

  const projectBills = await store.timeflowProjectBill.findMany({
    where,
    orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
  });

  res.json(projectBills);
});

router.get("/project-bills/:id", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const store = prisma as unknown as {
    timeflowProjectBill: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  };

  const projectBill = await store.timeflowProjectBill.findFirst({ where: { id, organizationId, userId } });
  if (!projectBill) {
    res.status(404).json({ error: "Project bill not found" });
    return;
  }

  res.json(projectBill);
});

router.post("/project-bills", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    timeflowClient: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
    timeflowProject: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
    timeflowProjectBill: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };

  if (typeof body.clientId !== "string") {
    res.status(400).json({ error: "clientId is required" });
    return;
  }
  if (typeof body.projectId !== "string") {
    res.status(400).json({ error: "projectId is required" });
    return;
  }
  if (typeof body.title !== "string" || !body.title.trim()) {
    res.status(400).json({ error: "title is required" });
    return;
  }

  const [client, project] = await Promise.all([
    store.timeflowClient.findFirst({ where: { id: body.clientId, organizationId, userId } }),
    store.timeflowProject.findFirst({ where: { id: body.projectId, organizationId, userId } }),
  ]);
  if (!client) {
    res.status(400).json({ error: "Client not found" });
    return;
  }
  if (!project) {
    res.status(400).json({ error: "Project not found" });
    return;
  }

  const projectBill = await store.timeflowProjectBill.create({
    data: {
      ...(typeof body.id === "string" && body.id.trim() ? { id: body.id.trim() } : {}),
      organizationId,
      userId,
      clientId: body.clientId,
      projectId: body.projectId,
      title: body.title.trim(),
      amount: typeof body.amount === "number" ? body.amount : 0,
      issueDate: typeof body.issueDate === "string" ? body.issueDate : new Date().toISOString().split("T")[0],
      dueDate: typeof body.dueDate === "string" ? body.dueDate : null,
      notes: typeof body.notes === "string" ? body.notes : "",
      status: typeof body.status === "string" ? body.status : "issued",
      paidAt: body.status === "paid" ? new Date() : null,
      voidedAt: body.status === "void" ? new Date() : null,
    },
  });

  res.status(201).json(projectBill);
});

router.put("/project-bills/:id", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    timeflowProjectBill: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.timeflowProjectBill.findFirst({ where: { id, organizationId, userId } });
  if (!existing) {
    res.status(404).json({ error: "Project bill not found" });
    return;
  }

  const data: Record<string, unknown> = {};
  if (typeof body.title === "string") data.title = body.title.trim();
  if (typeof body.amount === "number") data.amount = body.amount;
  if (typeof body.issueDate === "string") data.issueDate = body.issueDate;
  if ("dueDate" in body) data.dueDate = typeof body.dueDate === "string" ? body.dueDate : null;
  if ("notes" in body) data.notes = typeof body.notes === "string" ? body.notes : "";
  if ("status" in body && typeof body.status === "string") {
    data.status = body.status;
    data.paidAt = body.status === "paid" ? new Date() : null;
    data.voidedAt = body.status === "void" ? new Date() : null;
  }
  if ("paidAt" in body) data.paidAt = typeof body.paidAt === "string" ? new Date(body.paidAt) : null;
  if ("voidedAt" in body) data.voidedAt = typeof body.voidedAt === "string" ? new Date(body.voidedAt) : null;

  const updated = await store.timeflowProjectBill.update({ where: { id }, data });
  res.json(updated);
});

router.delete("/project-bills/:id", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { id } = req.params;
  const store = prisma as unknown as {
    timeflowProjectBill: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      delete: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const existing = await store.timeflowProjectBill.findFirst({ where: { id, organizationId, userId } });
  if (!existing) {
    res.status(404).json({ error: "Project bill not found" });
    return;
  }

  await store.timeflowProjectBill.delete({ where: { id } });
  res.status(204).send();
});

// ─── Health ───────────────────────────────────────────────────────────────────

router.get("/health", (_req, res) => {
  res.json({ ok: true, program: "timeflow", status: "ready" });
});

// ─── Workspace management ────────────────────────────────────────────────────

type WorkspaceStore = {
  organization: {
    findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  membership: {
    count: (args: Record<string, unknown>) => Promise<number>;
  };
  timeflowWorkspaceMeta: {
    findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    upsert: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  timeflowWorkspaceInvite: {
    create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
    findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    updateMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
  };
  timeflowClient: {
    count: (args: Record<string, unknown>) => Promise<number>;
  };
  timeflowProject: {
    count: (args: Record<string, unknown>) => Promise<number>;
  };
  timeflowTimeEntry: {
    count: (args: Record<string, unknown>) => Promise<number>;
  };
  timeflowExpense: {
    count: (args: Record<string, unknown>) => Promise<number>;
  };
  timeflowInvoice: {
    count: (args: Record<string, unknown>) => Promise<number>;
  };
};

function getWorkspaceStore(): WorkspaceStore {
  return prisma as unknown as WorkspaceStore;
}

function hashInviteToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function generateWorkspaceInviteToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString("hex");
  return { raw, hash: hashInviteToken(raw) };
}

function workspaceInviteExpiresAt(): Date {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
}

function toWorkspaceMeta(org: Record<string, unknown>, meta: Record<string, unknown> | null, memberCount: number) {
  const workspaceType = (meta?.workspaceType as string) ?? (memberCount > 1 ? "team" : "solo");
  return {
    workspaceType,
    solo: workspaceType === "solo",
    teamEnabled: Boolean(meta?.teamEnabled ?? (memberCount > 1)),
    isDefault: Boolean(meta?.isDefault ?? false),
  };
}

// GET /organizations — list all user's workspaces
router.get("/organizations", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId: tokenOrganizationId } = getUser(req);
  const store = getWorkspaceStore();

  const memberships = await (prisma as unknown as {
    membership: { findMany: (args: Record<string, unknown>) => Promise<Array<{ organizationId: string; role: string }>> };
  }).membership.findMany({
    where: { userId },
    select: { organizationId: true, role: true },
  });

  if (memberships.length === 0) {
    res.json({ organizations: [] });
    return;
  }

  const orgIds = memberships.map((m) => m.organizationId);

  const [orgs, metas, memberCounts] = await Promise.all([
    (prisma as unknown as {
      organization: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
    }).organization.findMany({
      where: { id: { in: orgIds }, isActive: true },
      select: { id: true, name: true, ownerEmail: true, createdAt: true, status: true },
    }),
    (prisma as unknown as {
      timeflowWorkspaceMeta: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
    }).timeflowWorkspaceMeta.findMany({
      where: { organizationId: { in: orgIds } },
    }),
    (prisma as unknown as {
      membership: { groupBy: (args: Record<string, unknown>) => Promise<Array<{ organizationId: string; _count: { id: number } }>> };
    }).membership.groupBy({
      by: ["organizationId"],
      where: { organizationId: { in: orgIds } },
      _count: { id: true },
    }),
  ]);

  const metaMap = new Map(metas.map((m) => [m.organizationId as string, m]));
  const memberCountMap = new Map(memberCounts.map((mc) => [mc.organizationId, mc._count.id]));
  const roleMap = new Map(memberships.map((m) => [m.organizationId, m.role]));

  const result = orgs.map((org) => {
    const orgId = org.id as string;
    const count = memberCountMap.get(orgId) ?? 1;
    const meta = metaMap.get(orgId) ?? null;
    const metaPayload = toWorkspaceMeta(org, meta, count);
    return {
      id: orgId,
      name: org.name,
      ownerUserId: org.ownerEmail,
      createdAt: org.createdAt,
      status: org.status,
      role: roleMap.get(orgId) ?? "member",
      ...metaPayload,
      isDefault: Boolean(metaPayload.isDefault || tokenOrganizationId === orgId),
    };
  });

  res.json({ organizations: result });
});

// POST /organizations — create a new workspace for current user
router.post("/organizations", requireTimeflowAuth, async (req, res) => {
  const { userId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const requestedName = typeof body.name === "string" ? body.name.trim() : "";
  const workspaceType = body.workspaceType === "solo" ? "solo" : "team";

  const user = await prismaUser.user.findUnique({ where: { id: userId } });
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }

  const organizationName = requestedName || `${user.displayName || user.email.split("@")[0] || "Workspace"} Team`;
  const baseSlug = slugifyOrganizationName(organizationName);
  let slug = baseSlug;
  let sequence = 1;
  while (await prisma.organization.findFirst({ where: { slug } })) {
    sequence += 1;
    slug = `${baseSlug}-${sequence}`;
  }

  const organization = await prisma.organization.create({
    data: {
      name: organizationName,
      slug,
      ownerEmail: user.email,
      contactEmail: user.email,
      status: "active",
      isActive: true,
    },
  });

  await prisma.membership.create({
    data: {
      userId: user.id,
      organizationId: organization.id,
      role: "owner",
    },
  });

  await (prisma as unknown as {
    timeflowWorkspaceMeta: { upsert: (args: Record<string, unknown>) => Promise<unknown> };
  }).timeflowWorkspaceMeta.upsert({
    where: { organizationId: organization.id },
    create: {
      organizationId: organization.id,
      workspaceType,
      teamEnabled: workspaceType === "team",
      isDefault: false,
    },
    update: {
      workspaceType,
      teamEnabled: workspaceType === "team",
    },
  });

  res.status(201).json({
    organization: {
      id: organization.id,
      name: organization.name,
      ownerUserId: user.id,
      createdAt: organization.createdAt,
      status: organization.status,
      workspaceType,
      solo: workspaceType === "solo",
      teamEnabled: workspaceType === "team",
      isDefault: false,
    },
  });
});

// PATCH /organizations/:id — rename workspace
router.patch("/organizations/:id", requireTimeflowAuth, async (req, res) => {
  const { userId } = getUser(req);
  const { id } = req.params;
  const body = isRecord(req.body) ? req.body : {};
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const store = getWorkspaceStore();

  // Must be owner or admin
  const membership = await (prisma as unknown as {
    membership: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  }).membership.findFirst({ where: { userId, organizationId: id } });

  if (!membership || !["owner", "admin"].includes(membership.role as string)) {
    res.status(403).json({ error: "Only workspace owners and admins can rename a workspace" });
    return;
  }

  const updated = await store.organization.update({
    where: { id },
    data: { name },
  });

  res.json({ id: updated.id, name: updated.name });
});

// POST /organizations/:id/archive — archive workspace
router.post("/organizations/:id/archive", requireTimeflowAuth, async (req, res) => {
  const { userId } = getUser(req);
  const { id } = req.params;

  const membership = await (prisma as unknown as {
    membership: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  }).membership.findFirst({ where: { userId, organizationId: id } });

  if (!membership || membership.role !== "owner") {
    res.status(403).json({ error: "Only the workspace owner can archive it" });
    return;
  }

  // Cannot archive last workspace
  const totalWorkspaces = await (prisma as unknown as {
    membership: { count: (args: Record<string, unknown>) => Promise<number> };
  }).membership.count({ where: { userId } });

  if (totalWorkspaces <= 1) {
    res.status(400).json({ error: "Cannot archive your only workspace" });
    return;
  }

  const store = getWorkspaceStore();
  await store.organization.update({ where: { id }, data: { status: "archived", isActive: false } });

  res.json({ archived: true });
});

// DELETE /organizations/:id — delete workspace (only if empty and not last)
router.delete("/organizations/:id", requireTimeflowAuth, async (req, res) => {
  const { userId } = getUser(req);
  const { id } = req.params;

  const membership = await (prisma as unknown as {
    membership: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  }).membership.findFirst({ where: { userId, organizationId: id } });

  if (!membership || membership.role !== "owner") {
    res.status(403).json({ error: "Only the workspace owner can delete it" });
    return;
  }

  const totalWorkspaces = await (prisma as unknown as {
    membership: { count: (args: Record<string, unknown>) => Promise<number> };
  }).membership.count({ where: { userId } });

  if (totalWorkspaces <= 1) {
    res.status(400).json({ error: "Cannot delete your only workspace. Archive it instead." });
    return;
  }

  const store = getWorkspaceStore();

  // Check non-owner members
  const nonOwnerMemberCount = await store.membership.count({
    where: { organizationId: id, NOT: { userId } },
  });

  if (nonOwnerMemberCount > 0) {
    res.status(400).json({
      error: "Workspace has team members. Remove all members before deleting.",
      code: "has_members",
    });
    return;
  }

  // Check data
  const [clients, projects, timeEntries, expenses, invoices] = await Promise.all([
    store.timeflowClient.count({ where: { organizationId: id } }),
    store.timeflowProject.count({ where: { organizationId: id } }),
    store.timeflowTimeEntry.count({ where: { organizationId: id } }),
    store.timeflowExpense.count({ where: { organizationId: id } }),
    store.timeflowInvoice.count({ where: { organizationId: id } }),
  ]);

  const hasData = clients > 0 || projects > 0 || timeEntries > 0 || expenses > 0 || invoices > 0;
  if (hasData) {
    res.status(400).json({
      error: "Workspace has data. Archive it instead of deleting.",
      code: "has_data",
      details: { clients, projects, timeEntries, expenses, invoices },
    });
    return;
  }

  // Safe to delete — hard delete org and memberships
  await (prisma as unknown as {
    membership: { deleteMany: (args: Record<string, unknown>) => Promise<unknown> };
  }).membership.deleteMany({ where: { organizationId: id } });

  await store.organization.update({ where: { id }, data: { isActive: false, status: "archived" } });

  res.json({ deleted: true });
});

// POST /organizations/:id/convert-to-team — solo → team conversion
router.post("/organizations/:id/convert-to-team", requireTimeflowAuth, async (req, res) => {
  const { userId } = getUser(req);
  const { id } = req.params;

  const membership = await (prisma as unknown as {
    membership: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  }).membership.findFirst({ where: { userId, organizationId: id } });

  if (!membership || !["owner", "admin"].includes(membership.role as string)) {
    res.status(403).json({ error: "Only owner or admin can convert workspace type" });
    return;
  }

  const store = getWorkspaceStore();
  const meta = await store.timeflowWorkspaceMeta.upsert({
    where: { organizationId: id },
    create: { organizationId: id, workspaceType: "team", teamEnabled: true },
    update: { workspaceType: "team", teamEnabled: true },
  });

  res.json({ organizationId: id, workspaceType: meta.workspaceType, teamEnabled: meta.teamEnabled });
});

// POST /organizations/:id/set-default — set user's default workspace
router.post("/organizations/:id/set-default", requireTimeflowAuth, async (req, res) => {
  const { userId } = getUser(req);
  const { id } = req.params;

  const membershipStore = prisma as unknown as {
    membership: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      findMany: (args: Record<string, unknown>) => Promise<Array<{ organizationId: string }>>;
    };
  };

  const hasMembership = await membershipStore.membership.findFirst({ where: { userId, organizationId: id } });
  if (!hasMembership) {
    res.status(403).json({ error: "You are not a member of this workspace" });
    return;
  }

  const userMemberships = await membershipStore.membership.findMany({ where: { userId }, select: { organizationId: true } });
  const orgIds = userMemberships.map((m) => m.organizationId);

  const metaStore = prisma as unknown as {
    timeflowWorkspaceMeta: {
      updateMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
      upsert: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  await metaStore.timeflowWorkspaceMeta.updateMany({
    where: { organizationId: { in: orgIds } },
    data: { isDefault: false },
  });

  await metaStore.timeflowWorkspaceMeta.upsert({
    where: { organizationId: id },
    create: { organizationId: id, isDefault: true, workspaceType: "solo", teamEnabled: false },
    update: { isDefault: true },
  });

  await prisma.user.update({ where: { id: userId }, data: { organizationId: id as string } });

  res.json({ defaultWorkspaceId: id });
});

// POST /organizations/:id/transfer-ownership — transfer owner role to another member
router.post("/organizations/:id/transfer-ownership", requireTimeflowAuth, async (req, res) => {
  const { userId } = getUser(req);
  const { id } = req.params;
  const body = isRecord(req.body) ? req.body : {};
  const newOwnerEmail = normalizeEmail(body.newOwnerEmail);

  if (!newOwnerEmail) {
    res.status(400).json({ error: "newOwnerEmail is required" });
    return;
  }

  const membershipStore = prisma as unknown as {
    membership: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  const actorMembership = await membershipStore.membership.findFirst({ where: { userId, organizationId: id } });
  if (!actorMembership || actorMembership.role !== "owner") {
    res.status(403).json({ error: "Only the workspace owner can transfer ownership" });
    return;
  }

  const targetUser = await prismaUser.user.findUnique({ where: { email: newOwnerEmail } });
  if (!targetUser) {
    res.status(404).json({ error: "Target user account not found" });
    return;
  }

  const targetMembership = await membershipStore.membership.findFirst({
    where: { userId: targetUser.id, organizationId: id },
  });

  if (!targetMembership) {
    res.status(400).json({ error: "Target user must be a workspace member before ownership transfer" });
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.membership.update({ where: { id: actorMembership.id as string }, data: { role: "admin" } });
    await tx.membership.update({ where: { id: targetMembership.id as string }, data: { role: "owner" } });
    await tx.organization.update({ where: { id: id as string }, data: { ownerEmail: targetUser.email! } });
  });

  res.json({ transferred: true, newOwnerEmail });
});

// ─── Team Invites ─────────────────────────────────────────────────────────────

const TEAM_INVITE_RESEND_COOLDOWN_MS = 60_000;

// POST /team-invites — create a new team invite and send email
router.post("/team-invites", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId, role: actorRole } = getUser(req);

  if (!["owner", "admin"].includes(actorRole)) {
    res.status(403).json({ error: "Only owners and admins can invite team members" });
    return;
  }

  const body = isRecord(req.body) ? req.body : {};
  const email = normalizeEmail(body.email);
  const name = typeof body.name === "string" ? body.name.trim() : undefined;
  const role = typeof body.role === "string" ? body.role : "employee";
  const employeeType = typeof body.employeeType === "string" ? body.employeeType : "employee";
  const hourlyRate = typeof body.hourlyRate === "number" ? body.hourlyRate : undefined;
  const canClockInOut = body.canClockInOut !== false;
  const targetOrgId = typeof body.organizationId === "string" ? body.organizationId : organizationId;

  if (!email) {
    res.status(400).json({ error: "email is required" });
    return;
  }

  const store = getWorkspaceStore();

  // Verify actor membership in target org
  const actorMembership = await (prisma as unknown as {
    membership: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  }).membership.findFirst({ where: { userId, organizationId: targetOrgId } });

  if (!actorMembership) {
    res.status(403).json({ error: "Not a member of this workspace" });
    return;
  }

  // Expire any old pending invites for this email in the org
  await store.timeflowWorkspaceInvite.updateMany({
    where: { organizationId: targetOrgId, email, status: "pending" },
    data: { status: "expired" },
  });

  const { raw, hash } = generateWorkspaceInviteToken();
  const expiresAt = workspaceInviteExpiresAt();

  const invite = await store.timeflowWorkspaceInvite.create({
    data: {
      organizationId: targetOrgId,
      email,
      name: name || undefined,
      role,
      employeeType,
      hourlyRate: hourlyRate ?? undefined,
      canClockInOut,
      status: "pending",
      tokenHash: hash,
      expiresAt,
      invitedByUserId: userId,
    },
  });

  // Fetch org name for email
  const org = await store.organization.findFirst({
    where: { id: targetOrgId },
    select: { name: true },
  } as Record<string, unknown>);

  const orgName = (org?.name as string) ?? "your workspace";
  const recipientName = name || email.split("@")[0];

  const emailSent = await sendTimeflowTeamInviteEmail({
    to: email,
    recipientName,
    organizationName: orgName,
    role,
    rawToken: raw,
    expiresAt,
  }).catch(() => false);

  logger.info("[timeflow] team invite created", {
    inviteId: invite.id,
    organizationId: targetOrgId,
    email,
    emailSent,
  });

  res.status(201).json({
    invite: {
      id: invite.id,
      organizationId: invite.organizationId,
      email: invite.email,
      name: invite.name,
      role: invite.role,
      employeeType: invite.employeeType,
      hourlyRate: invite.hourlyRate,
      canClockInOut: invite.canClockInOut,
      status: invite.status,
      expiresAt: invite.expiresAt,
      invitedAt: invite.invitedAt,
    },
    emailSent,
  });
});

// GET /team-invites — list invites for active org
router.get("/team-invites", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const targetOrgId = typeof req.query.organizationId === "string" ? req.query.organizationId : organizationId;

  const actorMembership = await (prisma as unknown as {
    membership: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  }).membership.findFirst({ where: { userId, organizationId: targetOrgId } });

  if (!actorMembership) {
    res.status(403).json({ error: "Not a member of this workspace" });
    return;
  }

  const store = getWorkspaceStore();
  const invites = await store.timeflowWorkspaceInvite.findMany({
    where: { organizationId: targetOrgId, status: { in: ["pending", "accepted"] } },
    orderBy: { invitedAt: "desc" },
  } as Record<string, unknown>);

  res.json({
    invites: invites.map((inv) => ({
      id: inv.id,
      organizationId: inv.organizationId,
      email: inv.email,
      name: inv.name,
      role: inv.role,
      employeeType: inv.employeeType,
      hourlyRate: inv.hourlyRate,
      canClockInOut: inv.canClockInOut,
      status: inv.status,
      expiresAt: inv.expiresAt,
      invitedAt: inv.invitedAt,
      acceptedAt: inv.acceptedAt,
    })),
  });
});

// POST /team-invites/:id/resend — resend invite email
router.post("/team-invites/:id/resend", requireTimeflowAuth, async (req, res) => {
  const { organizationId, role: actorRole } = getUser(req);
  const { id } = req.params;

  if (!["owner", "admin"].includes(actorRole)) {
    res.status(403).json({ error: "Only owners and admins can resend invites" });
    return;
  }

  const store = getWorkspaceStore();
  const invite = await store.timeflowWorkspaceInvite.findFirst({
    where: { id, organizationId },
    select: {
      id: true, organizationId: true, email: true, name: true, role: true,
      status: true, lastResentAt: true, expiresAt: true,
    },
  } as Record<string, unknown>);

  if (!invite) {
    res.status(404).json({ error: "Invite not found" });
    return;
  }

  if (invite.status !== "pending") {
    res.status(400).json({ error: "Only pending invites can be resent" });
    return;
  }

  const lastResent = invite.lastResentAt ? new Date(invite.lastResentAt as string).getTime() : 0;
  if (Date.now() - lastResent < TEAM_INVITE_RESEND_COOLDOWN_MS) {
    res.status(429).json({ error: "Please wait before resending again" });
    return;
  }

  // Regenerate token (old link becomes invalid)
  const { raw, hash } = generateWorkspaceInviteToken();
  const expiresAt = workspaceInviteExpiresAt();

  await store.timeflowWorkspaceInvite.update({
    where: { id },
    data: { tokenHash: hash, expiresAt, lastResentAt: new Date() },
  });

  const org = await store.organization.findFirst({
    where: { id: organizationId },
    select: { name: true },
  } as Record<string, unknown>);

  const orgName = (org?.name as string) ?? "your workspace";
  const recipientName = (invite.name as string | null | undefined) || (invite.email as string).split("@")[0];

  const emailSent = await sendTimeflowTeamInviteEmail({
    to: invite.email as string,
    recipientName,
    organizationName: orgName,
    role: invite.role as string,
    rawToken: raw,
    expiresAt,
  }).catch(() => false);

  res.json({ resent: true, emailSent });
});

// DELETE /team-invites/:id — revoke invite
router.delete("/team-invites/:id", requireTimeflowAuth, async (req, res) => {
  const { organizationId, role: actorRole } = getUser(req);
  const { id } = req.params;

  if (!["owner", "admin"].includes(actorRole)) {
    res.status(403).json({ error: "Only owners and admins can revoke invites" });
    return;
  }

  const store = getWorkspaceStore();
  const invite = await store.timeflowWorkspaceInvite.findFirst({
    where: { id, organizationId },
    select: { id: true, status: true },
  } as Record<string, unknown>);

  if (!invite) {
    res.status(404).json({ error: "Invite not found" });
    return;
  }

  await store.timeflowWorkspaceInvite.update({
    where: { id },
    data: { status: "revoked" },
  });

  res.json({ revoked: true });
});

// ─── Accept Invite (public — no auth required before account exists) ──────────

// GET /accept-invite?token=... — fetch invite details for pre-fill
router.get("/accept-invite", async (req, res) => {
  const rawToken = typeof req.query.token === "string" ? req.query.token.trim() : "";
  if (!rawToken) {
    res.status(400).json({ error: "token is required" });
    return;
  }

  const tokenHash = hashInviteToken(rawToken);
  const store = getWorkspaceStore();
  const invite = await store.timeflowWorkspaceInvite.findFirst({
    where: { tokenHash, status: "pending" },
    select: {
      id: true, organizationId: true, email: true, name: true, role: true,
      employeeType: true, hourlyRate: true, canClockInOut: true, expiresAt: true,
    },
  } as Record<string, unknown>);

  if (!invite) {
    res.status(404).json({ error: "Invite not found, expired, or already used" });
    return;
  }

  if (new Date(invite.expiresAt as string) < new Date()) {
    await store.timeflowWorkspaceInvite.update({ where: { id: invite.id }, data: { status: "expired" } });
    res.status(410).json({ error: "Invite has expired" });
    return;
  }

  const org = await store.organization.findFirst({
    where: { id: invite.organizationId as string },
    select: { name: true },
  } as Record<string, unknown>);

  res.json({
    invite: {
      id: invite.id,
      email: invite.email,
      name: invite.name,
      role: invite.role,
      employeeType: invite.employeeType,
      organizationName: (org?.name as string) ?? "Workspace",
      expiresAt: invite.expiresAt,
    },
  });
});

// POST /accept-invite — accept invite (create account if needed, or log in)
router.post("/accept-invite", async (req, res) => {
  const body = isRecord(req.body) ? req.body : {};
  const rawToken = typeof body.token === "string" ? body.token.trim() : "";
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  const displayName = normalizeDisplayName(body.displayName, email);

  if (!rawToken || !email) {
    res.status(400).json({ error: "token and email are required" });
    return;
  }

  const tokenHash = hashInviteToken(rawToken);
  const store = getWorkspaceStore();

  const invite = await store.timeflowWorkspaceInvite.findFirst({
    where: { tokenHash, status: "pending", email },
    select: {
      id: true, organizationId: true, email: true, name: true, role: true,
      employeeType: true, hourlyRate: true, canClockInOut: true, expiresAt: true,
    },
  } as Record<string, unknown>);

  if (!invite) {
    res.status(404).json({ error: "Invite not found, expired, or already used" });
    return;
  }

  if (new Date(invite.expiresAt as string) < new Date()) {
    await store.timeflowWorkspaceInvite.update({ where: { id: invite.id }, data: { status: "expired" } });
    res.status(410).json({ error: "Invite has expired" });
    return;
  }

  const orgId = invite.organizationId as string;
  let user = await prismaUser.user.findUnique({ where: { email } });

  if (!user) {
    // New user — password required
    if (!password || password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }
    user = await prismaUser.user.create({
      data: {
        organizationId: orgId,
        email,
        passwordHash: await hashPassword(password),
        role: (invite.role as string) === "owner" ? "owner" : "employee",
        displayName,
        identitySource: "invite",
      },
    });
  } else {
    // Existing user — verify password
    if (!password) {
      res.status(400).json({ error: "password is required" });
      return;
    }
    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: "Invalid password" });
      return;
    }
  }

  // Create or update membership
  const existingMembership = await (prisma as unknown as {
    membership: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  }).membership.findFirst({ where: { userId: user.id, organizationId: orgId } });

  if (!existingMembership) {
    await (prisma as unknown as {
      membership: { create: (args: Record<string, unknown>) => Promise<unknown> };
    }).membership.create({
      data: { userId: user.id, organizationId: orgId, role: invite.role as string },
    });
  }

  // Mark invite accepted
  await store.timeflowWorkspaceInvite.update({
    where: { id: invite.id },
    data: { status: "accepted", acceptedAt: new Date() },
  });

  // Ensure workspace is converted to team now that there are multiple members
  await store.timeflowWorkspaceMeta.upsert({
    where: { organizationId: orgId },
    create: { organizationId: orgId, workspaceType: "team", teamEnabled: true },
    update: { workspaceType: "team", teamEnabled: true },
  });

  // Issue token scoped to joined org
  const updatedUser = await prisma.user.update({
    where: { id: user.id },
    data: { organizationId: orgId },
  }) as unknown as TimeflowUserRecord;

  const token = signTimeflowToken(updatedUser);
  writeAuthCookies(res, token);
  res.setHeader("Authorization", `Bearer ${token}`);

  const org = await store.organization.findFirst({
    where: { id: orgId },
    select: { id: true, name: true },
  } as Record<string, unknown>);

  res.status(200).json({
    token,
    user: toAuthUserPayload(updatedUser),
    organization: org ? { id: org.id, name: org.name } : undefined,
  });
});

export { router as timeflowRouter };
