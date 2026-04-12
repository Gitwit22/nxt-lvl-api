/**
 * Platform Admin Routes
 *
 * These endpoints are only accessible to users with platformRole === "suite_admin".
 * They manage the subscription/entitlement model that controls which organizations
 * can access which programs.
 *
 * All routes are under /api/admin/*
 */
import express from "express";
import { prisma } from "../db/prisma.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { getRequestUser } from "../auth/auth.service.js";
import { logger } from "../../logger.js";

const router = express.Router();

// ─── Middleware: platform admin only ─────────────────────────────────────────

function requirePlatformAdmin(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const user = getRequestUser(req);
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  if (user.platformRole !== "suite_admin") {
    res.status(403).json({ error: "Platform admin access required" });
    return;
  }
  next();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

// ─── Organization lifecycle ───────────────────────────────────────────────────

/**
 * GET /api/admin/organizations
 * List all organizations (includes archived/suspended).
 */
router.get("/organizations", requireAuth, requirePlatformAdmin, async (_req, res) => {
  const orgs = await prisma.organization.findMany({ orderBy: { createdAt: "asc" } });
  res.json(orgs);
});

/**
 * POST /api/admin/organizations/:orgId/archive
 * Soft-archive an organization (sets status = "archived", isActive = false).
 */
router.post("/organizations/:orgId/archive", requireAuth, requirePlatformAdmin, async (req, res) => {
  const { orgId } = req.params;
  const existing = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!existing) { res.status(404).json({ error: "Organization not found" }); return; }

  const org = await prisma.organization.update({
    where: { id: orgId },
    data: { status: "archived", isActive: false },
  });

  logger.info("[admin] organization archived", { orgId, by: getRequestUser(req)?.userId });
  res.json(org);
});

/**
 * POST /api/admin/organizations/:orgId/restore
 * Restore an archived/suspended organization (sets status = "active", isActive = true).
 */
router.post("/organizations/:orgId/restore", requireAuth, requirePlatformAdmin, async (req, res) => {
  const { orgId } = req.params;
  const existing = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!existing) { res.status(404).json({ error: "Organization not found" }); return; }

  const org = await prisma.organization.update({
    where: { id: orgId },
    data: { status: "active", isActive: true },
  });

  logger.info("[admin] organization restored", { orgId, by: getRequestUser(req)?.userId });
  res.json(org);
});

/**
 * POST /api/admin/organizations/:orgId/suspend
 * Suspend an organization (disables access without archiving).
 */
router.post("/organizations/:orgId/suspend", requireAuth, requirePlatformAdmin, async (req, res) => {
  const { orgId } = req.params;
  const existing = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!existing) { res.status(404).json({ error: "Organization not found" }); return; }

  const org = await prisma.organization.update({
    where: { id: orgId },
    data: { status: "suspended", isActive: false },
  });

  logger.info("[admin] organization suspended", { orgId, by: getRequestUser(req)?.userId });
  res.json(org);
});

/**
 * DELETE /api/admin/organizations/:orgId
 * Permanent hard-delete. Requires explicit confirmation header to prevent accidents.
 * Header: X-Confirm-Delete: permanently-delete
 */
router.delete("/organizations/:orgId", requireAuth, requirePlatformAdmin, async (req, res) => {
  const { orgId } = req.params;
  const confirm = req.headers["x-confirm-delete"];
  if (confirm !== "permanently-delete") {
    res.status(400).json({
      error: "Permanent deletion requires header X-Confirm-Delete: permanently-delete",
    });
    return;
  }

  const existing = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!existing) { res.status(404).json({ error: "Organization not found" }); return; }
  if (existing.status !== "archived") {
    res.status(409).json({ error: "Organization must be archived before permanent deletion" });
    return;
  }

  await prisma.organization.delete({ where: { id: orgId } });
  logger.info("[admin] organization permanently deleted", { orgId, by: getRequestUser(req)?.userId });
  res.status(204).send();
});

// ─── Program subscriptions ────────────────────────────────────────────────────

const prismaExt = prisma as typeof prisma & {
  organizationProgramSubscription: {
    findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
    findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    upsert: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    delete: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
};

/**
 * GET /api/admin/organizations/:orgId/subscriptions
 * List all program subscriptions for an org.
 */
router.get("/organizations/:orgId/subscriptions", requireAuth, requirePlatformAdmin, async (req, res) => {
  const { orgId } = req.params;
  const subs = await prismaExt.organizationProgramSubscription.findMany({
    where: { organizationId: orgId },
    orderBy: { programId: "asc" },
  } as Record<string, unknown>);
  res.json(subs);
});

/**
 * PUT /api/admin/organizations/:orgId/subscriptions/:programId
 * Upsert a subscription (create or update). Platform admin sets status, source, dates.
 * Body: { status, subscriptionSource?, startsAt?, endsAt?, seatLimit?, notes? }
 */
router.put("/organizations/:orgId/subscriptions/:programId", requireAuth, requirePlatformAdmin, async (req, res) => {
  const { orgId, programId } = req.params;
  const body = isRecord(req.body) ? req.body : {};

  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) { res.status(404).json({ error: "Organization not found" }); return; }

  const status = typeof body.status === "string" ? body.status : "inactive";
  const subscriptionSource = typeof body.subscriptionSource === "string" ? body.subscriptionSource : "manual";
  const startsAt = typeof body.startsAt === "string" ? new Date(body.startsAt) : null;
  const endsAt = typeof body.endsAt === "string" ? new Date(body.endsAt) : null;
  const seatLimit = typeof body.seatLimit === "number" ? body.seatLimit : null;
  const notes = typeof body.notes === "string" ? body.notes : "";

  const sub = await prismaExt.organizationProgramSubscription.upsert({
    where: { organizationId_programId: { organizationId: orgId, programId } },
    create: { organizationId: orgId, programId, status, subscriptionSource, startsAt, endsAt, seatLimit, notes },
    update: { status, subscriptionSource, startsAt, endsAt, seatLimit, notes },
  } as Record<string, unknown>);

  logger.info("[admin] subscription upserted", {
    orgId, programId, status, by: getRequestUser(req)?.userId,
  });
  res.json(sub);
});

/**
 * DELETE /api/admin/organizations/:orgId/subscriptions/:programId
 * Remove a subscription row (revoke access entirely).
 */
router.delete("/organizations/:orgId/subscriptions/:programId", requireAuth, requirePlatformAdmin, async (req, res) => {
  const { orgId, programId } = req.params;
  const existing = await prismaExt.organizationProgramSubscription.findFirst({
    where: { organizationId: orgId, programId },
  } as Record<string, unknown>);
  if (!existing) { res.status(404).json({ error: "Subscription not found" }); return; }

  await prismaExt.organizationProgramSubscription.delete({
    where: { organizationId_programId: { organizationId: orgId, programId } },
  } as Record<string, unknown>);

  logger.info("[admin] subscription deleted", { orgId, programId, by: getRequestUser(req)?.userId });
  res.status(204).send();
});

/**
 * GET /api/admin/subscriptions
 * List all subscriptions across all orgs (for platform-wide overview).
 */
router.get("/subscriptions", requireAuth, requirePlatformAdmin, async (_req, res) => {
  const subs = await prismaExt.organizationProgramSubscription.findMany({
    orderBy: [{ organizationId: "asc" }, { programId: "asc" }],
  } as Record<string, unknown>);
  res.json(subs);
});

// ─── User program access ──────────────────────────────────────────────────────

/**
 * GET /api/admin/organizations/:orgId/user-access
 * List per-user program access within an org.
 */
router.get("/organizations/:orgId/user-access", requireAuth, requirePlatformAdmin, async (req, res) => {
  const { orgId } = req.params;
  const rows = await prisma.userProgramAccess.findMany({
    where: { organizationId: orgId },
    orderBy: [{ userId: "asc" }, { programId: "asc" }],
  });
  res.json(rows);
});

/**
 * PUT /api/admin/organizations/:orgId/user-access/:userId/:programId
 * Enable or disable a user's access to a program within an org.
 * Body: { enabled: boolean }
 */
router.put("/organizations/:orgId/user-access/:userId/:programId", requireAuth, requirePlatformAdmin, async (req, res) => {
  const { orgId, userId, programId } = req.params;
  const body = isRecord(req.body) ? req.body : {};
  const enabled = body.enabled !== false;

  const access = await prisma.userProgramAccess.upsert({
    where: { userId_organizationId_programId: { userId, organizationId: orgId, programId } },
    create: { userId, organizationId: orgId, programId, enabled },
    update: { enabled },
  });
  res.json(access);
});

export { router as adminRouter };
