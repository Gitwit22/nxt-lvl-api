/**
 * Portal Routes
 *
 * GET /api/portal/bootstrap
 *   Returns full org context for an org portal session — organization record,
 *   branding, active programs (from subscriptions), and optionally the current
 *   user's membership.
 *
 *   Org is resolved from (in priority order):
 *     1. `?slug=` query param
 *     2. `?subdomain=` query param
 *     3. `Host` header subdomain (*.ntlops.com)
 *
 *   Authentication is optional — unauthenticated requests still get org/branding
 *   data, but `membership` will be null.
 */
import express from "express";
import { prisma } from "../db/prisma.js";
import { tryAttachAuthUser, requireAuth } from "../middleware/auth.middleware.js";
import { getRequestUser } from "../auth/auth.service.js";
import { logger } from "../../logger.js";
import { provisionOrgFromAssignedIds } from "../services/orgProvisioning.js";

const router = express.Router();

const SUITE_DOMAIN_SUFFIXES = [".ntlops.com", ".nltops.com"];

function extractSubdomainFromHost(host: string): string | null {
  const h = (host || "").toLowerCase().split(":")[0];
  for (const suffix of SUITE_DOMAIN_SUFFIXES) {
    if (h.endsWith(suffix)) {
      const sub = h.slice(0, -suffix.length);
      if (sub && !sub.includes(".")) return sub;
    }
  }
  return null;
}

type OrgRow = {
  id: string;
  name: string;
  slug: string;
  subdomain: string | null;
  contactEmail: string | null;
  ownerEmail: string | null;
  supportEmail: string | null;
  phoneNumber: string | null;
  industryType: string | null;
  notes: string | null;
  logoUrl: string | null;
  bannerUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  assignedBundleIds: unknown;
  assignedProgramIds: unknown;
  planType: string;
  status: string;
  seatLimit: number;
  trialEndsAt: Date | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type ProgramRow = {
  id: string;
  slug: string;
  name: string;
  shortDescription: string;
  longDescription: string;
  category: string;
  tags: unknown;
  status: string;
  type: string;
  origin: string;
  internalRoute: string | null;
  externalUrl: string | null;
  openInNewTab: boolean;
  logoUrl: string | null;
  screenshotUrl: string | null;
  accentColor: string | null;
  isFeatured: boolean;
  isPublic: boolean;
  requiresLogin: boolean;
  requiresApproval: boolean;
  launchLabel: string;
  displayOrder: number;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
};

type SubscriptionRow = { programId: string; status: string };
type MembershipRow = { id: string; userId: string; role: string };
type UserRow = { id: string; email: string; displayName: string; firstName: string; lastName: string };

const prismaExt = prisma as typeof prisma & {
  organizationProgramSubscription: {
    findMany: (args: Record<string, unknown>) => Promise<SubscriptionRow[]>;
  };
};

// GET /api/portal/bootstrap
router.get("/bootstrap", async (req, res) => {
  // Optional auth — attach user if a valid token is present but don't 401 without one
  tryAttachAuthUser(req);
  const requestUser = getRequestUser(req);

  // Resolve org identifier
  const querySlug = typeof req.query.slug === "string" ? req.query.slug.trim() : "";
  const querySubdomain = typeof req.query.subdomain === "string" ? req.query.subdomain.trim() : "";
  const hostSubdomain = extractSubdomainFromHost(req.headers.host || "");

  let org: OrgRow | null = null;

  // Priority: explicit slug > explicit subdomain > Host header
  if (querySlug) {
    org = (await prisma.organization.findFirst({ where: { slug: querySlug } })) as OrgRow | null;
  } else if (querySubdomain) {
    org = (await prisma.organization.findFirst({ where: { subdomain: querySubdomain } })) as OrgRow | null;
    if (!org) {
      org = (await prisma.organization.findFirst({ where: { slug: querySubdomain } })) as OrgRow | null;
    }
  } else if (hostSubdomain) {
    org = (await prisma.organization.findFirst({ where: { subdomain: hostSubdomain } })) as OrgRow | null;
    if (!org) {
      org = (await prisma.organization.findFirst({ where: { slug: hostSubdomain } })) as OrgRow | null;
    }
  }

  if (!org) {
    res.status(404).json({ error: "Organization not found", code: "org_not_found" });
    return;
  }

  // ── Fetch active subscriptions ────────────────────────────────────────────
  const subscriptions = await prismaExt.organizationProgramSubscription.findMany({
    where: {
      organizationId: org.id,
      status: { in: ["active", "trialing"] },
    } as Record<string, unknown>,
  });

  let activeProgramIds = subscriptions.map((s) => s.programId);

  // First-run bootstrap: if no subscriptions exist yet, auto-provision from assignedProgramIds
  if (activeProgramIds.length === 0) {
    const rawIds = Array.isArray(org.assignedProgramIds) ? (org.assignedProgramIds as string[]) : [];
    if (rawIds.length > 0) {
      logger.info("[portal/bootstrap] no subscriptions found — auto-provisioning", {
        organizationId: org.id,
        programCount: rawIds.length,
      });
      try {
        await provisionOrgFromAssignedIds(org.id);
        // Re-fetch after provisioning
        const freshSubs = await prismaExt.organizationProgramSubscription.findMany({
          where: {
            organizationId: org.id,
            status: { in: ["active", "trialing"] },
          } as Record<string, unknown>,
        });
        activeProgramIds = freshSubs.map((s) => s.programId);
      } catch (err) {
        logger.error("[portal/bootstrap] auto-provisioning failed", {
          organizationId: org.id,
          error: err instanceof Error ? err.message : String(err),
        });
        // Fall back to assignedProgramIds as best-effort
        activeProgramIds = rawIds;
      }
    }
  }

  // ── Fetch program records ─────────────────────────────────────────────────
  let enabledPrograms: ProgramRow[] = [];
  if (activeProgramIds.length > 0) {
    enabledPrograms = (await prisma.program.findMany({
      where: {
        id: { in: activeProgramIds },
        deletedAt: null,
      } as Record<string, unknown>,
      orderBy: { displayOrder: "asc" },
    })) as ProgramRow[];
  }

  // ── Fetch membership for authenticated user ────────────────────────────────
  let membership: {
    orgId: string;
    userId: string;
    role: string;
    active: boolean;
    email: string;
    name: string;
  } | null = null;

  if (requestUser?.userId) {
    const membershipRow = (await prisma.membership.findFirst({
      where: { userId: requestUser.userId, organizationId: org.id },
    })) as MembershipRow | null;

    if (membershipRow) {
      const userRow = (await prisma.user.findUnique({
        where: { id: membershipRow.userId },
        select: { id: true, email: true, displayName: true, firstName: true, lastName: true },
      })) as UserRow | null;

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

  // ── Build branding object ─────────────────────────────────────────────────
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

  // ── Portal status ─────────────────────────────────────────────────────────
  const portalStatus = {
    status: org.status,
    isPending: org.status === "pending",
    isActive: org.isActive && org.status === "active",
    isSuspended: org.status === "suspended",
  };

  logger.info("[portal/bootstrap] served", {
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
    portalStatus,
  });
});

// ── Org subscription provisioning ────────────────────────────────────────────

// POST /api/portal/:orgId/provision
// Idempotent — creates/activates subscriptions for all assignedProgramIds on the org.
// Requires authentication (platform admin or org member).
router.post("/:orgId/provision", requireAuth, async (req, res) => {
  const orgId = typeof req.params.orgId === "string" ? req.params.orgId : "";
  if (!orgId) {
    res.status(400).json({ error: "orgId is required" });
    return;
  }

  try {
    const result = await provisionOrgFromAssignedIds(orgId);
    logger.info("[portal/provision] complete", { organizationId: orgId, ...result });
    res.json({
      success: true,
      organizationId: orgId,
      ...result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Provisioning failed";
    logger.error("[portal/provision] error", { organizationId: orgId, error: message });
    res.status(500).json({ error: message });
  }
});

export { router as portalRouter };
