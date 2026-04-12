/**
 * Program Access Middleware
 *
 * requireProgramSubscription(programId) — checks that the authenticated user's
 * organization has an active (status = "active" | "trialing") subscription for
 * the given program before allowing the request through.
 *
 * Designed to be placed as a router.use() AFTER the program-specific auth
 * middleware has already validated the token and attached the user. It reads
 * the user from whichever slot the auth middleware populated:
 *   - req._authUser        (core requireAuth / community-chronicle)
 *   - req.timeflowUser     (timeflow router)
 *   - req.missionHubUser   (mission-hub router)
 */
import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db/prisma.js";
import { getRequestUser } from "../auth/auth.service.js";
import { logger } from "../../logger.js";

type AnyUserWithOrg = { organizationId?: string; userId?: string };

const prismaExt = prisma as typeof prisma & {
  organizationProgramSubscription: {
    findFirst: (args: Record<string, unknown>) => Promise<{ id: string; status: string } | null>;
  };
};

function extractOrganizationId(req: Request): string | undefined {
  // Try core auth attachment first
  const coreUser = getRequestUser(req) as AnyUserWithOrg | undefined;
  if (coreUser?.organizationId) return coreUser.organizationId;

  // Timeflow program auth attachment
  const tfUser = (req as Request & { timeflowUser?: AnyUserWithOrg }).timeflowUser;
  if (tfUser?.organizationId) return tfUser.organizationId;

  // Mission Hub program auth attachment
  const mhUser = (req as Request & { missionHubUser?: AnyUserWithOrg }).missionHubUser;
  if (mhUser?.organizationId) return mhUser.organizationId;

  return undefined;
}

export function requireProgramSubscription(programId: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const organizationId = extractOrganizationId(req);

    // No user attached — auth middleware will 401 this request. Let it through.
    if (!organizationId) {
      next();
      return;
    }

    try {
      const sub = await prismaExt.organizationProgramSubscription.findFirst({
        where: {
          organizationId,
          programId,
          status: { in: ["active", "trialing"] },
        },
      } as Record<string, unknown>);

      if (!sub) {
        logger.warn("[access] subscription check failed", { organizationId, programId });
        res.status(403).json({
          error: "Your organization does not have an active subscription for this program.",
          code: "program_not_subscribed",
        });
        return;
      }

      next();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Subscription check failed";
      logger.error("[access] subscription check error", { organizationId, programId, error: message });
      res.status(500).json({ error: "Failed to verify program access" });
    }
  };
}
