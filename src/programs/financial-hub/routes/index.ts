import express, { type NextFunction, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../../core/db/prisma.js";
import { JWT_EXPIRES_IN, JWT_SECRET } from "../../../core/config/env.js";
import { hashPassword, signToken } from "../../../core/auth/auth.service.js";

const router = express.Router();

const FINANCIAL_HUB_PROGRAM_DOMAIN = "financial-hub";
const FINANCE_STATUS_VALUES = new Set([
  "received",
  "validation_pending",
  "needs_correction",
  "finance_ready",
  "exported",
  "posted",
  "archived",
]);
const SOURCE_APP_VALUES = new Set(["time-flow", "mission-hub", "manual"]);
const SOURCE_RECORD_TYPE_VALUES = new Set([
  "timesheet",
  "expense",
  "income",
  "cash_disbursement",
  "invoice",
  "event",
]);

const DEFAULT_CAPABILITIES = {
  canManageFinanceSettings: true,
  canReviewFinanceIntake: true,
  canApproveFinanceReady: true,
  canExportFinanceData: true,
  canManageUsers: true,
  canViewReports: true,
  canManageOrganization: true,
};

type FinancialHubTokenPayload = {
  userId: string;
  email: string;
  role: string;
  platformRole?: string;
  organizationId: string;
  programDomain: string;
};

type PrismaWithFinancialHub = typeof prisma & {
  financialHubUserProfile: {
    count: (args?: Record<string, unknown>) => Promise<number>;
    findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    upsert: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  financeIntakeRecord: {
    findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    groupBy: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    aggregate: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
};

const prismaFinancial = prisma as PrismaWithFinancialHub;

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validatePassword(password: string): string | null {
  if (!password || password.length < 8) {
    return "Password must be at least 8 characters";
  }
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  if (!hasLetter || !hasDigit) {
    return "Password must include at least one letter and one number";
  }
  return null;
}

function slugifyOrganization(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function readTokenFromRequest(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);

  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  for (const item of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = item.trim().split("=");
    const key = rawKey?.trim();
    if (!key) continue;
    if (["token", "accessToken", "authToken", "jwt", "session"].includes(key)) {
      return decodeURIComponent(rawValue.join("=") || "");
    }
  }
  return undefined;
}

function decodeFinancialHubToken(token: string): FinancialHubTokenPayload | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as FinancialHubTokenPayload;
    if (payload.programDomain !== FINANCIAL_HUB_PROGRAM_DOMAIN) return null;
    if (!payload.organizationId || !payload.userId) return null;
    return payload;
  } catch {
    return null;
  }
}

function requireFinancialHubAuth(req: Request, res: Response, next: NextFunction): void {
  const token = readTokenFromRequest(req);
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const payload = decodeFinancialHubToken(token);
  if (!payload) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  (req as Request & { financialHubUser: FinancialHubTokenPayload }).financialHubUser = payload;
  next();
}

function getFinancialHubUser(req: Request): FinancialHubTokenPayload {
  return (req as Request & { financialHubUser: FinancialHubTokenPayload }).financialHubUser;
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
  res.cookie("financialHubToken", token, baseCookie);
}

async function getSetupStatus() {
  const initialAdminCount = await prismaFinancial.financialHubUserProfile.count({
    where: {
      programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
      isInitialAdmin: true,
    },
  });

  const organizationCount = await prisma.organizationProgramSubscription.count({
    where: {
      programId: FINANCIAL_HUB_PROGRAM_DOMAIN,
      status: { in: ["active", "trialing"] },
    },
  });

  const initialAdminExists = initialAdminCount > 0;
  const organizationExists = organizationCount > 0;

  return {
    setupRequired: !(organizationExists && initialAdminExists),
    organizationExists,
    initialAdminExists,
  };
}

function mapIntakeRecord(record: Record<string, unknown>) {
  return {
    id: String(record.id),
    organizationId: String(record.organizationId),
    programDomain: String(record.programDomain),
    sourceApp: String(record.sourceApp),
    sourceRecordId: String(record.sourceRecordId),
    sourceRecordType: String(record.sourceRecordType),
    sourceStatus: typeof record.sourceStatus === "string" ? record.sourceStatus : null,
    financeStatus: String(record.financeStatus),
    title: typeof record.title === "string" ? record.title : "",
    description: typeof record.description === "string" ? record.description : null,
    amount: typeof record.amount === "number" ? record.amount : 0,
    currency: typeof record.currency === "string" ? record.currency : "USD",
    transactionDate: record.transactionDate instanceof Date ? record.transactionDate.toISOString() : null,
    payPeriodId: typeof record.payPeriodId === "string" ? record.payPeriodId : null,
    employeeId: typeof record.employeeId === "string" ? record.employeeId : null,
    volunteerId: typeof record.volunteerId === "string" ? record.volunteerId : null,
    programId: typeof record.programId === "string" ? record.programId : null,
    grantId: typeof record.grantId === "string" ? record.grantId : null,
    eventId: typeof record.eventId === "string" ? record.eventId : null,
    expenseId: typeof record.expenseId === "string" ? record.expenseId : null,
    timesheetId: typeof record.timesheetId === "string" ? record.timesheetId : null,
    fundingSourceId: typeof record.fundingSourceId === "string" ? record.fundingSourceId : null,
    submittedByUserId: typeof record.submittedByUserId === "string" ? record.submittedByUserId : null,
    operationallyApprovedByUserId:
      typeof record.operationallyApprovedByUserId === "string" ? record.operationallyApprovedByUserId : null,
    financeReviewedByUserId:
      typeof record.financeReviewedByUserId === "string" ? record.financeReviewedByUserId : null,
    financeReviewedAt: record.financeReviewedAt instanceof Date ? record.financeReviewedAt.toISOString() : null,
    exportBatchId: typeof record.exportBatchId === "string" ? record.exportBatchId : null,
    postedAt: record.postedAt instanceof Date ? record.postedAt.toISOString() : null,
    metadata: record.metadata ?? {},
    attachments: record.attachments ?? [],
    validationIssues: record.validationIssues ?? [],
    createdByUserId: typeof record.createdByUserId === "string" ? record.createdByUserId : null,
    createdAt: record.createdAt instanceof Date ? record.createdAt.toISOString() : null,
    updatedAt: record.updatedAt instanceof Date ? record.updatedAt.toISOString() : null,
  };
}

router.get("/health", (_req, res) => {
  res.json({
    ok: true,
    program: "Financial Hub",
    programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
    capabilities: {
      setup: true,
      intake: true,
      reviewQueue: true,
      reports: true,
      exports: true,
      settings: true,
    },
  });
});

router.get("/setup/status", async (_req, res) => {
  const status = await getSetupStatus();
  res.json(status);
});

router.post("/setup/initial-user", async (req, res) => {
  const status = await getSetupStatus();
  if (!status.setupRequired) {
    res.status(409).json({ error: "Setup already completed" });
    return;
  }

  const body = isRecord(req.body) ? req.body : {};
  const organizationName = normalizeString(body.organizationName);
  const adminName = normalizeString(body.adminName);
  const adminEmail = normalizeEmail(body.adminEmail);
  const password = typeof body.password === "string" ? body.password : "";
  const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : "";
  const phone = optionalString(body.phone);
  const title = optionalString(body.title);
  const defaultTimezone = optionalString(body.defaultTimezone) || "America/New_York";

  if (!organizationName || !adminName || !adminEmail || !password || !confirmPassword) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }
  if (password !== confirmPassword) {
    res.status(400).json({ error: "Passwords do not match" });
    return;
  }
  const passwordError = validatePassword(password);
  if (passwordError) {
    res.status(400).json({ error: passwordError });
    return;
  }

  const baseSlug = slugifyOrganization(organizationName) || "organization";
  const nowSuffix = Date.now().toString(36);
  const orgSlug = `${baseSlug}-${nowSuffix}`;

  try {
    const existingUser = await prisma.user.findUnique({ where: { email: adminEmail } });
    if (existingUser) {
      res.status(409).json({ error: "Duplicate email" });
      return;
    }

    const created = await prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: {
          name: organizationName,
          slug: orgSlug,
          contactEmail: adminEmail,
          ownerEmail: adminEmail,
          supportEmail: adminEmail,
          phoneNumber: phone,
          status: "active",
          isActive: true,
        },
      });

      const user = await tx.user.create({
        data: {
          organizationId: organization.id,
          email: adminEmail,
          passwordHash: await hashPassword(password),
          role: "admin",
          platformRole: "user",
          displayName: adminName,
          firstName: adminName.split(" ")[0] || adminName,
          lastName: adminName.split(" ").slice(1).join(" "),
          identitySource: "local",
        },
      });

      await tx.membership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          role: "owner",
        },
      });

      await tx.organizationProgramSubscription.upsert({
        where: {
          organizationId_programId: {
            organizationId: organization.id,
            programId: FINANCIAL_HUB_PROGRAM_DOMAIN,
          },
        },
        update: {
          status: "active",
          subscriptionSource: "manual",
          startsAt: new Date(),
          notes: "Created by Financial Hub initial setup",
        },
        create: {
          organizationId: organization.id,
          programId: FINANCIAL_HUB_PROGRAM_DOMAIN,
          status: "active",
          subscriptionSource: "manual",
          startsAt: new Date(),
          notes: "Created by Financial Hub initial setup",
        },
      });

      await tx.userProgramAccess.upsert({
        where: {
          userId_organizationId_programId: {
            userId: user.id,
            organizationId: organization.id,
            programId: FINANCIAL_HUB_PROGRAM_DOMAIN,
          },
        },
        update: { enabled: true },
        create: {
          userId: user.id,
          organizationId: organization.id,
          programId: FINANCIAL_HUB_PROGRAM_DOMAIN,
          enabled: true,
        },
      });

      await (tx as unknown as PrismaWithFinancialHub).financialHubUserProfile.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
          phone,
          title,
          defaultTimezone,
          capabilities: DEFAULT_CAPABILITIES,
          isInitialAdmin: true,
          createdByUserId: user.id,
        },
      });

      await tx.programStorageSettings.upsert({
        where: {
          organizationId_programDomain: {
            organizationId: organization.id,
            programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
          },
        },
        update: {
          settings: {
            defaultTimezone,
            createdFromInitialSetup: true,
          },
        },
        create: {
          organizationId: organization.id,
          programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
          settings: {
            defaultTimezone,
            createdFromInitialSetup: true,
          },
        },
      });

      return { organization, user };
    });

    const token = signToken({
      userId: created.user.id,
      email: created.user.email,
      role: created.user.role,
      platformRole: created.user.platformRole,
      organizationId: created.organization.id,
      programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
    });

    writeAuthCookies(res, token);
    res.setHeader("Authorization", `Bearer ${token}`);
    res.status(201).json({
      token,
      user: {
        id: created.user.id,
        email: created.user.email,
        role: created.user.role,
        platformRole: created.user.platformRole,
        displayName: created.user.displayName,
        organizationId: created.organization.id,
        organizationName: created.organization.name,
        programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
        capabilities: DEFAULT_CAPABILITIES,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to complete setup";
    if (message.toLowerCase().includes("unique") || message.toLowerCase().includes("duplicate")) {
      res.status(409).json({ error: "Duplicate email" });
      return;
    }
    res.status(500).json({ error: message });
  }
});

router.get("/me", requireFinancialHubAuth, async (req, res) => {
  const user = getFinancialHubUser(req);
  const [dbUser, profile] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.userId } }),
    prismaFinancial.financialHubUserProfile.findFirst({
      where: {
        userId: user.userId,
        organizationId: user.organizationId,
        programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
      },
    }),
  ]);

  if (!dbUser) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({
    user: {
      id: dbUser.id,
      email: dbUser.email,
      role: dbUser.role,
      displayName: dbUser.displayName,
      organizationId: user.organizationId,
      programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
      capabilities: (profile?.capabilities as Record<string, boolean> | undefined) || DEFAULT_CAPABILITIES,
    },
  });
});

router.get("/intake", requireFinancialHubAuth, async (req, res) => {
  const user = getFinancialHubUser(req);
  const financeStatus = optionalString(req.query.financeStatus);

  const rows = await prismaFinancial.financeIntakeRecord.findMany({
    where: {
      organizationId: user.organizationId,
      programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
      ...(financeStatus ? { financeStatus } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  res.json({ items: rows.map(mapIntakeRecord) });
});

router.post("/intake", requireFinancialHubAuth, async (req, res) => {
  const user = getFinancialHubUser(req);
  const body = isRecord(req.body) ? req.body : {};

  const sourceApp = normalizeString(body.sourceApp);
  const sourceRecordId = normalizeString(body.sourceRecordId);
  const sourceRecordType = normalizeString(body.sourceRecordType);
  const financeStatus = normalizeString(body.financeStatus || "received") || "received";
  const title = normalizeString(body.title);
  const amount = typeof body.amount === "number" ? body.amount : Number(body.amount || 0);
  const currency = normalizeString(body.currency || "USD") || "USD";

  if (!SOURCE_APP_VALUES.has(sourceApp)) {
    res.status(400).json({ error: "Invalid sourceApp" });
    return;
  }
  if (!SOURCE_RECORD_TYPE_VALUES.has(sourceRecordType)) {
    res.status(400).json({ error: "Invalid sourceRecordType" });
    return;
  }
  if (!FINANCE_STATUS_VALUES.has(financeStatus)) {
    res.status(400).json({ error: "Invalid financeStatus" });
    return;
  }
  if (!sourceRecordId || !title) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }
  if (!Number.isFinite(amount)) {
    res.status(400).json({ error: "Invalid amount" });
    return;
  }

  try {
    const created = await prismaFinancial.financeIntakeRecord.create({
      data: {
        organizationId: user.organizationId,
        programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
        sourceApp,
        sourceRecordId,
        sourceRecordType,
        sourceStatus: optionalString(body.sourceStatus),
        financeStatus,
        title,
        description: optionalString(body.description),
        amount,
        currency,
        transactionDate: optionalString(body.transactionDate) ? new Date(String(body.transactionDate)) : null,
        payPeriodId: optionalString(body.payPeriodId),
        employeeId: optionalString(body.employeeId),
        volunteerId: optionalString(body.volunteerId),
        programId: optionalString(body.programId),
        grantId: optionalString(body.grantId),
        eventId: optionalString(body.eventId),
        expenseId: optionalString(body.expenseId),
        timesheetId: optionalString(body.timesheetId),
        fundingSourceId: optionalString(body.fundingSourceId),
        submittedByUserId: optionalString(body.submittedByUserId) || user.userId,
        operationallyApprovedByUserId: optionalString(body.operationallyApprovedByUserId),
        metadata: isRecord(body.metadata) ? body.metadata : {},
        attachments: Array.isArray(body.attachments) ? body.attachments : [],
        validationIssues: Array.isArray(body.validationIssues) ? body.validationIssues : [],
        createdByUserId: user.userId,
      },
    });

    res.status(201).json({ item: mapIntakeRecord(created) });
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("unique") || message.includes("duplicate")) {
      res.status(409).json({ error: "Duplicate source record for this organization" });
      return;
    }
    res.status(500).json({ error: "Failed to create intake record" });
  }
});

router.patch("/intake/:id/status", requireFinancialHubAuth, async (req, res) => {
  const user = getFinancialHubUser(req);
  const recordId = normalizeString(req.params.id);
  const body = isRecord(req.body) ? req.body : {};
  const financeStatus = normalizeString(body.financeStatus);

  if (!recordId || !FINANCE_STATUS_VALUES.has(financeStatus)) {
    res.status(400).json({ error: "Invalid intake status update" });
    return;
  }

  const existing = await prismaFinancial.financeIntakeRecord.findFirst({
    where: {
      id: recordId,
      organizationId: user.organizationId,
      programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
    },
  });
  if (!existing) {
    res.status(404).json({ error: "Record not found" });
    return;
  }

  const reviewed = ["needs_correction", "finance_ready", "exported", "posted", "archived"].includes(financeStatus);
  const updated = await prismaFinancial.financeIntakeRecord.update({
    where: { id: recordId },
    data: {
      financeStatus,
      financeReviewedByUserId: reviewed ? user.userId : null,
      financeReviewedAt: reviewed ? new Date() : null,
      postedAt: financeStatus === "posted" ? new Date() : null,
      exportBatchId: optionalString(body.exportBatchId),
    },
  });

  res.json({ item: mapIntakeRecord(updated) });
});

router.get("/review-queue", requireFinancialHubAuth, async (req, res) => {
  const user = getFinancialHubUser(req);
  const rows = await prismaFinancial.financeIntakeRecord.findMany({
    where: {
      organizationId: user.organizationId,
      programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
      financeStatus: { in: ["received", "validation_pending", "needs_correction"] },
    },
    orderBy: { createdAt: "asc" },
    take: 200,
  });

  res.json({ items: rows.map(mapIntakeRecord) });
});

router.get("/reports", requireFinancialHubAuth, async (req, res) => {
  const user = getFinancialHubUser(req);

  const [statusCounts, totals] = await Promise.all([
    prismaFinancial.financeIntakeRecord.groupBy({
      by: ["financeStatus"],
      where: {
        organizationId: user.organizationId,
        programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
      },
      _count: { _all: true },
    }),
    prismaFinancial.financeIntakeRecord.aggregate({
      where: {
        organizationId: user.organizationId,
        programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
      },
      _count: { _all: true },
      _sum: { amount: true },
    }),
  ]);

  res.json({
    summary: {
      totalRecords: Number((totals._count as { _all?: number } | undefined)?._all || 0),
      totalAmount: Number((totals._sum as { amount?: number } | undefined)?.amount || 0),
    },
    statuses: statusCounts.map((entry) => ({
      financeStatus: String(entry.financeStatus),
      count: Number((entry._count as { _all?: number } | undefined)?._all || 0),
    })),
  });
});

router.get("/exports", requireFinancialHubAuth, async (req, res) => {
  const user = getFinancialHubUser(req);
  const rows = await prismaFinancial.financeIntakeRecord.findMany({
    where: {
      organizationId: user.organizationId,
      programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
      financeStatus: { in: ["finance_ready", "exported", "posted"] },
    },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });

  res.json({ items: rows.map(mapIntakeRecord) });
});

router.get("/settings", requireFinancialHubAuth, async (req, res) => {
  const user = getFinancialHubUser(req);

  const settings = await prisma.programStorageSettings.findUnique({
    where: {
      organizationId_programDomain: {
        organizationId: user.organizationId,
        programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
      },
    },
  });

  res.json({
    settings: settings?.settings || {},
    organizationId: user.organizationId,
    programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
  });
});

router.patch("/settings", requireFinancialHubAuth, async (req, res) => {
  const user = getFinancialHubUser(req);
  const body = isRecord(req.body) ? req.body : {};
  const normalizedSettings = body as Prisma.InputJsonValue;

  const saved = await prisma.programStorageSettings.upsert({
    where: {
      organizationId_programDomain: {
        organizationId: user.organizationId,
        programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
      },
    },
    update: {
      settings: normalizedSettings,
    },
    create: {
      organizationId: user.organizationId,
      programDomain: FINANCIAL_HUB_PROGRAM_DOMAIN,
      settings: normalizedSettings,
    },
  });

  res.json({ settings: saved.settings });
});

export { router as financialHubRouter };
