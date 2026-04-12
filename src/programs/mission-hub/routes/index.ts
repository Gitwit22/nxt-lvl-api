/**
 * Mission Hub API Routes
 *
 * All endpoints are scoped by organizationId + userId extracted from the JWT.
 * Phase 1: auth gate is open — requireMissionHubAuth verifies the token when
 * provided but the frontend currently bypasses the auth handoff, so the
 * consume endpoint is kept for future use.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../../../core/db/prisma.js";
import { JWT_SECRET } from "../../../core/config/env.js";
import { signToken } from "../../../core/auth/auth.service.js";
import { requireProgramSubscription } from "../../../core/middleware/program-access.middleware.js";
import { logger } from "../../../logger.js";

const router = express.Router();

const MISSION_HUB_PROGRAM_DOMAIN = "mission-hub";

// ─── Auth helpers ─────────────────────────────────────────────────────────────

interface MissionHubTokenPayload {
  userId: string;
  email: string;
  role: string;
  organizationId: string;
  programDomain: string;
}

function readTokenFromRequest(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  for (const item of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = item.trim().split("=");
    const key = rawKey?.trim();
    if (key && ["token", "accessToken", "authToken", "missionHubToken"].includes(key)) {
      return decodeURIComponent(rawValue.join("=") || "");
    }
  }
  return undefined;
}

function decodeMissionHubToken(token: string): MissionHubTokenPayload | undefined {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as MissionHubTokenPayload;
    if (payload.programDomain !== MISSION_HUB_PROGRAM_DOMAIN) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

function requireMissionHubAuth(req: Request, res: Response, next: NextFunction): void {
  const token = readTokenFromRequest(req);
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const payload = decodeMissionHubToken(token);
  if (!payload) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }
  (req as Request & { missionHubUser: MissionHubTokenPayload }).missionHubUser = payload;
  next();
}

function getUser(req: Request): MissionHubTokenPayload {
  return (req as Request & { missionHubUser: MissionHubTokenPayload }).missionHubUser;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ─── Platform Auth / Consume ──────────────────────────────────────────────────

router.post("/platform-auth/consume", async (req, res) => {
  const body = isRecord(req.body) ? req.body : {};
  const launchToken =
    typeof body.launchToken === "string" ? body.launchToken :
    typeof body.token === "string" ? body.token : undefined;

  if (!launchToken) {
    res.status(400).json({ error: "launchToken is required" });
    return;
  }

  let claims: { userId: string; email: string; role: string; organizationId: string } | undefined;

  try {
    const payload = jwt.verify(launchToken, JWT_SECRET) as Record<string, unknown>;
    const userId = typeof payload.userId === "string" ? payload.userId : undefined;
    const email = typeof payload.email === "string" ? payload.email : undefined;
    const organizationId = typeof payload.organizationId === "string" ? payload.organizationId : undefined;
    const role = typeof payload.role === "string" ? payload.role : "member";
    if (userId && email && organizationId) claims = { userId, email, role, organizationId };
  } catch { /* invalid */ }

  if (!claims) {
    res.status(401).json({ error: "Invalid or expired launch token", code: "invalid_launch_token" });
    return;
  }

  const missionHubToken = signToken({
    userId: claims.userId,
    email: claims.email,
    role: claims.role,
    organizationId: claims.organizationId,
    programDomain: MISSION_HUB_PROGRAM_DOMAIN,
  });

  const secureCookie = process.env.NODE_ENV === "production";
  res.cookie("missionHubToken", missionHubToken, {
    httpOnly: true,
    secure: secureCookie,
    sameSite: secureCookie ? "none" : "lax",
    maxAge: 8 * 60 * 60 * 1000,
    path: "/",
  });

  res.json({
    token: missionHubToken,
    user: {
      id: claims.userId,
      email: claims.email,
      role: claims.role,
      organizationId: claims.organizationId,
      programDomain: MISSION_HUB_PROGRAM_DOMAIN,
    },
  });

  logger.info("[mission-hub] platform-auth/consume success", {
    userId: claims.userId,
    organizationId: claims.organizationId,
  });
});

// ─── Subscription gate ────────────────────────────────────────────────────────
// All routes below require a valid Mission Hub JWT and an active subscription.
router.use(requireMissionHubAuth, requireProgramSubscription("mission-hub"));

// ─── Programs ────────────────────────────────────────────────────────────────

router.get("/programs", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubProgram: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };
  const programs = await store.missionHubProgram.findMany({
    where: { organizationId, userId, isActive: true },
    orderBy: { name: "asc" },
  });
  res.json(programs);
});

router.get("/programs/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubProgram: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  };
  const program = await store.missionHubProgram.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!program) { res.status(404).json({ error: "Program not found" }); return; }
  res.json(program);
});

router.post("/programs", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubProgram: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };
  if (typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "name is required" }); return;
  }
  const program = await store.missionHubProgram.create({
    data: {
      organizationId, userId,
      name: (body.name as string).trim(),
      category: typeof body.category === "string" ? body.category : "",
      manager: typeof body.manager === "string" ? body.manager : "",
      status: typeof body.status === "string" ? body.status : "Active",
      startDate: typeof body.startDate === "string" ? body.startDate : "",
      endDate: typeof body.endDate === "string" ? body.endDate : null,
      budget: typeof body.budget === "string" ? body.budget : "",
      budgetAmount: typeof body.budgetAmount === "number" ? body.budgetAmount : 0,
      progress: typeof body.progress === "number" ? body.progress : 0,
      description: typeof body.description === "string" ? body.description : "",
      targetAudience: typeof body.targetAudience === "string" ? body.targetAudience : "",
      team: Array.isArray(body.team) ? body.team : [],
      timeEntries: Array.isArray(body.timeEntries) ? body.timeEntries : [],
      budgetItems: Array.isArray(body.budgetItems) ? body.budgetItems : [],
      supporters: Array.isArray(body.supporters) ? body.supporters : [],
      sponsors: Array.isArray(body.sponsors) ? body.sponsors : [],
      documents: Array.isArray(body.documents) ? body.documents : [],
      tasks: Array.isArray(body.tasks) ? body.tasks : [],
      outcomes: Array.isArray(body.outcomes) ? body.outcomes : [],
    },
  });
  res.status(201).json(program);
});

router.put("/programs/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubProgram: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubProgram.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Program not found" }); return; }

  const data: Record<string, unknown> = {};
  const strFields = ["name", "category", "manager", "status", "startDate", "budget", "description", "targetAudience"] as const;
  for (const f of strFields) { if (typeof body[f] === "string") data[f] = body[f]; }
  if ("endDate" in body) data.endDate = typeof body.endDate === "string" ? body.endDate : null;
  if (typeof body.budgetAmount === "number") data.budgetAmount = body.budgetAmount;
  if (typeof body.progress === "number") data.progress = body.progress;
  const jsonFields = ["team", "timeEntries", "budgetItems", "supporters", "sponsors", "documents", "tasks", "outcomes"] as const;
  for (const f of jsonFields) { if (f in body && Array.isArray(body[f])) data[f] = body[f]; }

  const updated = await store.missionHubProgram.update({ where: { id: req.params.id }, data });
  res.json(updated);
});

router.delete("/programs/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubProgram: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubProgram.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Program not found" }); return; }
  await store.missionHubProgram.update({ where: { id: req.params.id }, data: { isActive: false } });
  res.status(204).send();
});

// ─── Grants ───────────────────────────────────────────────────────────────────

router.get("/grants", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubGrant: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };
  const grants = await store.missionHubGrant.findMany({
    where: { organizationId, userId, isActive: true },
    orderBy: { grantName: "asc" },
  });
  res.json(grants);
});

router.get("/grants/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubGrant: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  };
  const grant = await store.missionHubGrant.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!grant) { res.status(404).json({ error: "Grant not found" }); return; }
  res.json(grant);
});

router.post("/grants", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubGrant: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };
  if (typeof body.grantName !== "string" || !body.grantName.trim()) {
    res.status(400).json({ error: "grantName is required" }); return;
  }
  const grant = await store.missionHubGrant.create({
    data: {
      organizationId, userId,
      grantName: (body.grantName as string).trim(),
      fundingSource: typeof body.fundingSource === "string" ? body.fundingSource : "",
      amountAwarded: typeof body.amountAwarded === "number" ? body.amountAwarded : 0,
      startDate: typeof body.startDate === "string" ? body.startDate : "",
      endDate: typeof body.endDate === "string" ? body.endDate : null,
      status: typeof body.status === "string" ? body.status : "Active",
      grantManager: typeof body.grantManager === "string" ? body.grantManager : "",
      linkedPrograms: Array.isArray(body.linkedPrograms) ? body.linkedPrograms : [],
      reportingStatus: typeof body.reportingStatus === "string" ? body.reportingStatus : "",
      requirements: Array.isArray(body.requirements) ? body.requirements : [],
      budgetAllocation: Array.isArray(body.budgetAllocation) ? body.budgetAllocation : [],
      reportingDeadlines: Array.isArray(body.reportingDeadlines) ? body.reportingDeadlines : [],
    },
  });
  res.status(201).json(grant);
});

router.put("/grants/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubGrant: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubGrant.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Grant not found" }); return; }

  const data: Record<string, unknown> = {};
  const strFields = ["grantName", "fundingSource", "status", "grantManager", "reportingStatus"] as const;
  for (const f of strFields) { if (typeof body[f] === "string") data[f] = body[f]; }
  if (typeof body.amountAwarded === "number") data.amountAwarded = body.amountAwarded;
  if (typeof body.startDate === "string") data.startDate = body.startDate;
  if ("endDate" in body) data.endDate = typeof body.endDate === "string" ? body.endDate : null;
  const jsonFields = ["linkedPrograms", "requirements", "budgetAllocation", "reportingDeadlines"] as const;
  for (const f of jsonFields) { if (f in body && Array.isArray(body[f])) data[f] = body[f]; }

  const updated = await store.missionHubGrant.update({ where: { id: req.params.id }, data });
  res.json(updated);
});

router.delete("/grants/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubGrant: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubGrant.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Grant not found" }); return; }
  await store.missionHubGrant.update({ where: { id: req.params.id }, data: { isActive: false } });
  res.status(204).send();
});

// ─── Expenses ─────────────────────────────────────────────────────────────────

router.get("/expenses", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { category, approvalStatus } = req.query;
  const store = prisma as unknown as {
    missionHubExpense: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };
  const where: Record<string, unknown> = { organizationId, userId, isActive: true };
  if (typeof category === "string") where.category = category;
  if (typeof approvalStatus === "string") where.approvalStatus = approvalStatus;
  const expenses = await store.missionHubExpense.findMany({ where, orderBy: { date: "desc" } });
  res.json(expenses);
});

router.get("/expenses/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubExpense: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  };
  const expense = await store.missionHubExpense.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!expense) { res.status(404).json({ error: "Expense not found" }); return; }
  res.json(expense);
});

router.post("/expenses", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubExpense: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };
  if (typeof body.expenseName !== "string" || !body.expenseName.trim()) {
    res.status(400).json({ error: "expenseName is required" }); return;
  }
  const expense = await store.missionHubExpense.create({
    data: {
      organizationId, userId,
      expenseName: (body.expenseName as string).trim(),
      amount: typeof body.amount === "number" ? body.amount : 0,
      date: typeof body.date === "string" ? body.date : "",
      category: typeof body.category === "string" ? body.category : "",
      type: typeof body.type === "string" ? body.type : "",
      linkedProgramId: typeof body.linkedProgramId === "string" ? body.linkedProgramId : null,
      linkedProgram: typeof body.linkedProgram === "string" ? body.linkedProgram : null,
      linkedGrant: typeof body.linkedGrant === "string" ? body.linkedGrant : null,
      linkedCampaign: typeof body.linkedCampaign === "string" ? body.linkedCampaign : null,
      fundingSource: typeof body.fundingSource === "string" ? body.fundingSource : null,
      notes: typeof body.notes === "string" ? body.notes : "",
      approvalStatus: typeof body.approvalStatus === "string" ? body.approvalStatus : "Pending",
      recurring: body.recurring === true,
    },
  });
  res.status(201).json(expense);
});

router.put("/expenses/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubExpense: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubExpense.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Expense not found" }); return; }

  const data: Record<string, unknown> = {};
  const strFields = ["expenseName", "date", "category", "type", "notes", "approvalStatus"] as const;
  for (const f of strFields) { if (typeof body[f] === "string") data[f] = body[f]; }
  if (typeof body.amount === "number") data.amount = body.amount;
  if (typeof body.recurring === "boolean") data.recurring = body.recurring;
  const nullableStr = ["linkedProgramId", "linkedProgram", "linkedGrant", "linkedCampaign", "fundingSource"] as const;
  for (const f of nullableStr) { if (f in body) data[f] = typeof body[f] === "string" ? body[f] : null; }

  const updated = await store.missionHubExpense.update({ where: { id: req.params.id }, data });
  res.json(updated);
});

router.delete("/expenses/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubExpense: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubExpense.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Expense not found" }); return; }
  await store.missionHubExpense.update({ where: { id: req.params.id }, data: { isActive: false } });
  res.status(204).send();
});

// ─── Sponsors ─────────────────────────────────────────────────────────────────

router.get("/sponsors", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { status } = req.query;
  const store = prisma as unknown as {
    missionHubSponsor: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };
  const where: Record<string, unknown> = { organizationId, userId, isActive: true };
  if (typeof status === "string") where.status = status;
  const sponsors = await store.missionHubSponsor.findMany({ where, orderBy: { organizationName: "asc" } });
  res.json(sponsors);
});

router.get("/sponsors/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubSponsor: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  };
  const sponsor = await store.missionHubSponsor.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!sponsor) { res.status(404).json({ error: "Sponsor not found" }); return; }
  res.json(sponsor);
});

router.post("/sponsors", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubSponsor: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };
  if (typeof body.organizationName !== "string" || !body.organizationName.trim()) {
    res.status(400).json({ error: "organizationName is required" }); return;
  }
  const sponsor = await store.missionHubSponsor.create({
    data: {
      organizationId, userId,
      organizationName: (body.organizationName as string).trim(),
      sponsorType: typeof body.sponsorType === "string" ? body.sponsorType : "",
      contactName: typeof body.contactName === "string" ? body.contactName : "",
      email: typeof body.email === "string" ? body.email : "",
      phone: typeof body.phone === "string" ? body.phone : "",
      contributionAmount: typeof body.contributionAmount === "number" ? body.contributionAmount : 0,
      contributionType: typeof body.contributionType === "string" ? body.contributionType : "",
      paymentStatus: typeof body.paymentStatus === "string" ? body.paymentStatus : "",
      status: typeof body.status === "string" ? body.status : "Active",
      notes: typeof body.notes === "string" ? body.notes : "",
      linkedPrograms: Array.isArray(body.linkedPrograms) ? body.linkedPrograms : [],
      linkedCampaigns: Array.isArray(body.linkedCampaigns) ? body.linkedCampaigns : [],
      linkedItems: Array.isArray(body.linkedItems) ? body.linkedItems : [],
    },
  });
  res.status(201).json(sponsor);
});

router.put("/sponsors/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubSponsor: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubSponsor.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Sponsor not found" }); return; }

  const data: Record<string, unknown> = {};
  const strFields = ["organizationName", "sponsorType", "contactName", "email", "phone", "contributionType", "paymentStatus", "status", "notes"] as const;
  for (const f of strFields) { if (typeof body[f] === "string") data[f] = body[f]; }
  if (typeof body.contributionAmount === "number") data.contributionAmount = body.contributionAmount;
  const jsonFields = ["linkedPrograms", "linkedCampaigns", "linkedItems"] as const;
  for (const f of jsonFields) { if (f in body && Array.isArray(body[f])) data[f] = body[f]; }

  const updated = await store.missionHubSponsor.update({ where: { id: req.params.id }, data });
  res.json(updated);
});

router.delete("/sponsors/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubSponsor: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubSponsor.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Sponsor not found" }); return; }
  await store.missionHubSponsor.update({ where: { id: req.params.id }, data: { isActive: false } });
  res.status(204).send();
});

// ─── Campaigns ────────────────────────────────────────────────────────────────

router.get("/campaigns", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { status } = req.query;
  const store = prisma as unknown as {
    missionHubCampaign: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };
  const where: Record<string, unknown> = { organizationId, userId, isActive: true };
  if (typeof status === "string") where.status = status;
  const campaigns = await store.missionHubCampaign.findMany({ where, orderBy: { name: "asc" } });
  res.json(campaigns);
});

router.get("/campaigns/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubCampaign: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  };
  const campaign = await store.missionHubCampaign.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!campaign) { res.status(404).json({ error: "Campaign not found" }); return; }
  res.json(campaign);
});

router.post("/campaigns", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubCampaign: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };
  if (typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "name is required" }); return;
  }
  const campaign = await store.missionHubCampaign.create({
    data: {
      organizationId, userId,
      name: (body.name as string).trim(),
      category: typeof body.category === "string" ? body.category : "Event",
      status: typeof body.status === "string" ? body.status : "Planning",
      owner: typeof body.owner === "string" ? body.owner : "",
      startDate: typeof body.startDate === "string" ? body.startDate : "",
      endDate: typeof body.endDate === "string" ? body.endDate : null,
      goalAmount: typeof body.goalAmount === "number" ? body.goalAmount : 0,
      linkedPrograms: Array.isArray(body.linkedPrograms) ? body.linkedPrograms : [],
      tiers: Array.isArray(body.tiers) ? body.tiers : [],
      items: Array.isArray(body.items) ? body.items : [],
      donations: Array.isArray(body.donations) ? body.donations : [],
      events: Array.isArray(body.events) ? body.events : [],
      expenses: Array.isArray(body.expenses) ? body.expenses : [],
      documents: Array.isArray(body.documents) ? body.documents : [],
    },
  });
  res.status(201).json(campaign);
});

router.put("/campaigns/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubCampaign: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubCampaign.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Campaign not found" }); return; }

  const data: Record<string, unknown> = {};
  const strFields = ["name", "category", "status", "owner", "startDate"] as const;
  for (const f of strFields) { if (typeof body[f] === "string") data[f] = body[f]; }
  if ("endDate" in body) data.endDate = typeof body.endDate === "string" ? body.endDate : null;
  if (typeof body.goalAmount === "number") data.goalAmount = body.goalAmount;
  const jsonFields = ["linkedPrograms", "tiers", "items", "donations", "events", "expenses", "documents"] as const;
  for (const f of jsonFields) { if (f in body && Array.isArray(body[f])) data[f] = body[f]; }

  const updated = await store.missionHubCampaign.update({ where: { id: req.params.id }, data });
  res.json(updated);
});

router.delete("/campaigns/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubCampaign: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubCampaign.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Campaign not found" }); return; }
  await store.missionHubCampaign.update({ where: { id: req.params.id }, data: { isActive: false } });
  res.status(204).send();
});

// ─── Personnel ────────────────────────────────────────────────────────────────

router.get("/personnel", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { status, type } = req.query;
  const store = prisma as unknown as {
    missionHubPersonnel: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };
  const where: Record<string, unknown> = { organizationId, userId, isActive: true };
  if (typeof status === "string") where.status = status;
  if (typeof type === "string") where.type = type;
  const personnel = await store.missionHubPersonnel.findMany({
    where,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  res.json(personnel);
});

router.get("/personnel/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubPersonnel: { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
  };
  const person = await store.missionHubPersonnel.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!person) { res.status(404).json({ error: "Personnel record not found" }); return; }
  res.json(person);
});

router.post("/personnel", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubPersonnel: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };
  if (typeof body.firstName !== "string" || !body.firstName.trim()) {
    res.status(400).json({ error: "firstName is required" }); return;
  }
  if (typeof body.lastName !== "string" || !body.lastName.trim()) {
    res.status(400).json({ error: "lastName is required" }); return;
  }
  const person = await store.missionHubPersonnel.create({
    data: {
      organizationId, userId,
      firstName: (body.firstName as string).trim(),
      lastName: (body.lastName as string).trim(),
      email: typeof body.email === "string" ? body.email : "",
      phone: typeof body.phone === "string" ? body.phone : "",
      title: typeof body.title === "string" ? body.title : "",
      department: typeof body.department === "string" ? body.department : "",
      type: typeof body.type === "string" ? body.type : "Staff",
      role: typeof body.role === "string" ? body.role : "Admin",
      status: typeof body.status === "string" ? body.status : "Active",
      accessLevel: typeof body.accessLevel === "string" ? body.accessLevel : "Basic",
      assignedPrograms: Array.isArray(body.assignedPrograms) ? body.assignedPrograms : [],
      assignedGrants: Array.isArray(body.assignedGrants) ? body.assignedGrants : [],
      notes: typeof body.notes === "string" ? body.notes : "",
    },
  });
  res.status(201).json(person);
});

router.put("/personnel/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubPersonnel: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubPersonnel.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Personnel record not found" }); return; }

  const data: Record<string, unknown> = {};
  const strFields = ["firstName", "lastName", "email", "phone", "title", "department", "type", "role", "status", "accessLevel", "notes"] as const;
  for (const f of strFields) { if (typeof body[f] === "string") data[f] = body[f]; }
  const jsonFields = ["assignedPrograms", "assignedGrants"] as const;
  for (const f of jsonFields) { if (f in body && Array.isArray(body[f])) data[f] = body[f]; }

  const updated = await store.missionHubPersonnel.update({ where: { id: req.params.id }, data });
  res.json(updated);
});

router.delete("/personnel/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubPersonnel: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubPersonnel.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Personnel record not found" }); return; }
  await store.missionHubPersonnel.update({ where: { id: req.params.id }, data: { isActive: false } });
  res.status(204).send();
});

// ─── Calendar Entries ─────────────────────────────────────────────────────────

router.get("/calendar", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { dateFrom, dateTo } = req.query;
  const store = prisma as unknown as {
    missionHubCalendarEntry: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };
  const where: Record<string, unknown> = { organizationId, userId, isActive: true };
  if (typeof dateFrom === "string" || typeof dateTo === "string") {
    where.date = {};
    if (typeof dateFrom === "string") (where.date as Record<string, unknown>).gte = dateFrom;
    if (typeof dateTo === "string") (where.date as Record<string, unknown>).lte = dateTo;
  }
  const entries = await store.missionHubCalendarEntry.findMany({ where, orderBy: { date: "asc" } });
  res.json(entries);
});

router.post("/calendar", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubCalendarEntry: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };
  if (typeof body.title !== "string" || !body.title.trim()) {
    res.status(400).json({ error: "title is required" }); return;
  }
  if (typeof body.date !== "string" || !body.date.trim()) {
    res.status(400).json({ error: "date is required" }); return;
  }
  const entry = await store.missionHubCalendarEntry.create({
    data: {
      organizationId, userId,
      title: (body.title as string).trim(),
      date: body.date as string,
      type: typeof body.type === "string" ? body.type : "",
      description: typeof body.description === "string" ? body.description : "",
      linkedEntity: typeof body.linkedEntity === "string" ? body.linkedEntity : null,
      linkedEntityId: typeof body.linkedEntityId === "string" ? body.linkedEntityId : null,
    },
  });
  res.status(201).json(entry);
});

router.put("/calendar/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubCalendarEntry: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubCalendarEntry.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Calendar entry not found" }); return; }

  const data: Record<string, unknown> = {};
  const strFields = ["title", "date", "type", "description"] as const;
  for (const f of strFields) { if (typeof body[f] === "string") data[f] = body[f]; }
  if ("linkedEntity" in body) data.linkedEntity = typeof body.linkedEntity === "string" ? body.linkedEntity : null;
  if ("linkedEntityId" in body) data.linkedEntityId = typeof body.linkedEntityId === "string" ? body.linkedEntityId : null;

  const updated = await store.missionHubCalendarEntry.update({ where: { id: req.params.id }, data });
  res.json(updated);
});

router.delete("/calendar/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubCalendarEntry: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubCalendarEntry.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Calendar entry not found" }); return; }
  await store.missionHubCalendarEntry.update({ where: { id: req.params.id }, data: { isActive: false } });
  res.status(204).send();
});

// ─── Saved Reports ────────────────────────────────────────────────────────────

router.get("/reports", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubSavedReport: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };
  const reports = await store.missionHubSavedReport.findMany({
    where: { organizationId, userId, isActive: true },
    orderBy: [{ isFavorite: "desc" }, { name: "asc" }],
  });
  res.json(reports);
});

router.post("/reports", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubSavedReport: { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };
  if (typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "name is required" }); return;
  }
  const report = await store.missionHubSavedReport.create({
    data: {
      organizationId, userId,
      name: (body.name as string).trim(),
      description: typeof body.description === "string" ? body.description : "",
      config: isRecord(body.config) ? body.config : {},
      isFavorite: body.isFavorite === true,
      lastRun: typeof body.lastRun === "string" ? body.lastRun : null,
    },
  });
  res.status(201).json(report);
});

router.put("/reports/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const store = prisma as unknown as {
    missionHubSavedReport: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubSavedReport.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Report not found" }); return; }

  const data: Record<string, unknown> = {};
  if (typeof body.name === "string") data.name = body.name.trim();
  if (typeof body.description === "string") data.description = body.description;
  if (isRecord(body.config)) data.config = body.config;
  if (typeof body.isFavorite === "boolean") data.isFavorite = body.isFavorite;
  if ("lastRun" in body) data.lastRun = typeof body.lastRun === "string" ? body.lastRun : null;

  const updated = await store.missionHubSavedReport.update({ where: { id: req.params.id }, data });
  res.json(updated);
});

router.delete("/reports/:id", requireMissionHubAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const store = prisma as unknown as {
    missionHubSavedReport: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const existing = await store.missionHubSavedReport.findFirst({ where: { id: req.params.id, organizationId, userId } });
  if (!existing) { res.status(404).json({ error: "Report not found" }); return; }
  await store.missionHubSavedReport.update({ where: { id: req.params.id }, data: { isActive: false } });
  res.status(204).send();
});

// ─── Health ───────────────────────────────────────────────────────────────────

router.get("/health", (_req, res) => {
  res.json({ ok: true, program: "mission-hub", status: "ready" });
});

export { router as missionHubRouter };
