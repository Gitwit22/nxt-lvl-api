import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db/prisma.js";
import { getRequestUser } from "../auth/auth.service.js";
import { getRequestProgram } from "./partition.middleware.js";
import { tryAttachAuthUser } from "./auth.middleware.js";

/**
 * Middleware that verifies the user's organization has an active subscription
 * (status = "active" or "trialing") for the current program partition.
 *
 * Must be mounted AFTER partitionMiddleware and auth attachment.
 * Allows unauthenticated requests to pass through (auth middleware will reject them later).
 * Allows platform-auth endpoints so launch-token consumption isn't blocked.
 */
export function requireProgramSubscription(req: Request, res: Response, next: NextFunction): void {
  // Let platform-auth endpoints through — they handle their own gating
  if (req.path.startsWith("/platform-auth")) {
    next();
    return;
  }

  // Let health checks through
  if (req.path === "/health" || req.path === "/healthz") {
    next();
    return;
  }

  // Try to attach auth user if not already attached
  tryAttachAuthUser(req);

  const user = getRequestUser(req);
  if (!user) {
    // No auth yet — let downstream auth middleware handle rejection
    next();
    return;
  }

  const program = getRequestProgram(req);
  const programId = program?.key;
  if (!programId) {
    next();
    return;
  }

  void prisma.organizationProgramSubscription
    .findUnique({
      where: {
        organizationId_programId: {
          organizationId: user.organizationId,
          programId,
        },
      },
      select: { status: true },
    })
    .then((sub) => {
      if (!sub || (sub.status !== "active" && sub.status !== "trialing")) {
        res.status(403).json({
          error: "Your organization does not have an active subscription to this program.",
          code: "subscription_required",
          program: programId,
        });
        return;
      }
      next();
    })
    .catch((err) => {
      next(err);
    });
}
