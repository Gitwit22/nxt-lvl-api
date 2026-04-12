/**
 * Timeflow API Routes
 *
 * All endpoints are scoped by organizationId + userId extracted from the JWT.
 * The JWT must have programDomain === "timeflow" (issued by this consume endpoint
 * or by the suite platform-auth flow with programDomain: "timeflow").
 */
import express, { type NextFunction, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../../../core/db/prisma.js";
import { JWT_SECRET } from "../../../core/config/env.js";
import { signToken } from "../../../core/auth/auth.service.js";
import { requireProgramSubscription } from "../../../core/middleware/program-access.middleware.js";
import { logger } from "../../../logger.js";

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

function readTokenFromRequest(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  for (const item of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = item.trim().split("=");
    const key = rawKey?.trim();
    if (key && ["token", "accessToken", "authToken", "timeflowToken"].includes(key)) {
      return decodeURIComponent(rawValue.join("=") || "");
    }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ─── Platform Auth / Consume ──────────────────────────────────────────────────

/**
 * POST /api/timeflow/platform-auth/consume
 * Accepts a suite launch token and returns a Timeflow-scoped JWT.
 */
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

  // Verify with platform launch secret
  try {
    const payload = jwt.verify(launchToken, PLATFORM_LAUNCH_TOKEN_SECRET) as Record<string, unknown>;
    const userId = typeof payload.userId === "string" ? payload.userId : undefined;
    const email = typeof payload.email === "string" ? payload.email : undefined;
    const organizationId = typeof payload.organizationId === "string" ? payload.organizationId : undefined;
    const role = typeof payload.role === "string" ? payload.role : "contractor";

    if (userId && email && organizationId) {
      claims = { userId, email, role, organizationId };
    }
  } catch {
    // fall through — also try platform JWT secret as fallback
  }

  if (!claims) {
    // Fallback: try decoding with the standard JWT secret (dev / same-domain scenario)
    try {
      const payload = jwt.verify(launchToken, JWT_SECRET) as Record<string, unknown>;
      const userId = typeof payload.userId === "string" ? payload.userId : undefined;
      const email = typeof payload.email === "string" ? payload.email : undefined;
      const organizationId = typeof payload.organizationId === "string" ? payload.organizationId : undefined;
      const role = typeof payload.role === "string" ? payload.role : "contractor";

      if (userId && email && organizationId) {
        claims = { userId, email, role, organizationId };
      }
    } catch {
      // invalid token
    }
  }

  if (!claims) {
    res.status(401).json({ error: "Invalid or expired launch token", code: "invalid_launch_token" });
    return;
  }

  // Map suite role → Timeflow role
  const timeflowRole = ["org_admin", "admin", "owner", "contractor"].includes(claims.role)
    ? "contractor"
    : "client_viewer";

  // Ensure settings row exists for this user (creates on first launch)
  const tfStore = prisma as unknown as {
    timeflowSettings: {
      findUnique: (args: { where: Record<string, unknown> }) => Promise<Record<string, unknown> | null>;
      create: (args: { data: Record<string, unknown> }) => Promise<Record<string, unknown>>;
    };
  };

  const existingSettings = await tfStore.timeflowSettings.findUnique({
    where: { organizationId_userId: { organizationId: claims.organizationId, userId: claims.userId } },
  }).catch(() => null);

  if (!existingSettings) {
    await tfStore.timeflowSettings.create({
      data: {
        organizationId: claims.organizationId,
        userId: claims.userId,
        businessName: claims.email.split("@")[0] ?? "",
      },
    }).catch(() => undefined);
  }

  const timeflowToken = signToken({
    userId: claims.userId,
    email: claims.email,
    role: timeflowRole,
    organizationId: claims.organizationId,
    programDomain: TIMEFLOW_PROGRAM_DOMAIN,
  });

  const secureCookie = process.env.NODE_ENV === "production";
  res.cookie("timeflowToken", timeflowToken, {
    httpOnly: true,
    secure: secureCookie,
    sameSite: secureCookie ? "none" : "lax",
    maxAge: 8 * 60 * 60 * 1000,
    path: "/",
  });

  res.json({
    token: timeflowToken,
    user: {
      id: claims.userId,
      email: claims.email,
      role: timeflowRole,
      organizationId: claims.organizationId,
      programDomain: TIMEFLOW_PROGRAM_DOMAIN,
    },
  });

  logger.info("[timeflow] platform-auth/consume success", {
    userId: claims.userId,
    organizationId: claims.organizationId,
  });
});

// ─── Subscription gate ────────────────────────────────────────────────────────
// All routes below this point require both a valid Timeflow JWT AND an active
// OrganizationProgramSubscription for "timeflow". The requireTimeflowAuth call
// that runs here is redundant with per-route checks but ensures the user is
// attached before the subscription check inspects it.
router.use(requireTimeflowAuth, requireProgramSubscription("timeflow"));

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
      create: { organizationId, userId, businessName: "" },
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
  if (typeof body.invoiceNotes === "string") data.invoiceNotes = body.invoiceNotes;
  if (typeof body.paymentInstructions === "string") data.paymentInstructions = body.paymentInstructions;
  if ("invoiceLogoDataUrl" in body) data.invoiceLogoDataUrl = typeof body.invoiceLogoDataUrl === "string" ? body.invoiceLogoDataUrl : null;
  if ("invoiceBannerDataUrl" in body) data.invoiceBannerDataUrl = typeof body.invoiceBannerDataUrl === "string" ? body.invoiceBannerDataUrl : null;
  if (typeof body.companyViewerAccess === "boolean") data.companyViewerAccess = body.companyViewerAccess;
  if (typeof body.emailTemplate === "string") data.emailTemplate = body.emailTemplate;

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
    where: { organizationId, userId, isActive: true },
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

// ─── Projects ─────────────────────────────────────────────────────────────────

router.get("/projects", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { clientId } = req.query;
  const store = prisma as unknown as {
    timeflowProject: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };

  const where: Record<string, unknown> = { organizationId, userId, isActive: true };
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

// ─── Time Entries ─────────────────────────────────────────────────────────────

router.get("/time-entries", requireTimeflowAuth, async (req, res) => {
  const { userId, organizationId } = getUser(req);
  const { clientId, projectId, invoiced, status, dateFrom, dateTo } = req.query;
  const store = prisma as unknown as {
    timeflowTimeEntry: { findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]> };
  };

  const where: Record<string, unknown> = { organizationId, userId };
  if (typeof clientId === "string") where.clientId = clientId;
  if (typeof projectId === "string") where.projectId = projectId;
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

  const entry = await store.timeflowTimeEntry.create({
    data: {
      organizationId,
      userId,
      clientId: body.clientId as string,
      projectId: typeof body.projectId === "string" ? body.projectId : null,
      date: typeof body.date === "string" ? body.date : new Date().toISOString().split("T")[0],
      startTime: typeof body.startTime === "string" ? body.startTime : "00:00",
      endTime: typeof body.endTime === "string" ? body.endTime : null,
      durationHours: typeof body.durationHours === "number" ? body.durationHours : 0,
      billingRate: typeof body.billingRate === "number" ? body.billingRate : null,
      billable: body.billable !== false,
      invoiced: body.invoiced === true,
      invoiceId: typeof body.invoiceId === "string" ? body.invoiceId : null,
      notes: typeof body.notes === "string" ? body.notes : "",
      status: typeof body.status === "string" ? body.status : "completed",
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
  if (typeof body.clientId === "string") data.clientId = body.clientId;
  if ("projectId" in body) data.projectId = typeof body.projectId === "string" ? body.projectId : null;
  if (typeof body.date === "string") data.date = body.date;
  if (typeof body.startTime === "string") data.startTime = body.startTime;
  if ("endTime" in body) data.endTime = typeof body.endTime === "string" ? body.endTime : null;
  if (typeof body.durationHours === "number") data.durationHours = body.durationHours;
  if ("billingRate" in body) data.billingRate = typeof body.billingRate === "number" ? body.billingRate : null;
  if (typeof body.billable === "boolean") data.billable = body.billable;
  if (typeof body.invoiced === "boolean") data.invoiced = body.invoiced;
  if ("invoiceId" in body) data.invoiceId = typeof body.invoiceId === "string" ? body.invoiceId : null;
  if (typeof body.notes === "string") data.notes = body.notes;
  if (typeof body.status === "string") data.status = body.status;

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

// ─── Health ───────────────────────────────────────────────────────────────────

router.get("/health", (_req, res) => {
  res.json({ ok: true, program: "timeflow", status: "ready" });
});

export { router as timeflowRouter };
