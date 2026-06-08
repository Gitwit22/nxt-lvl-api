import type { NextFunction, Request, Response } from "express";
import { CURRENT_PROGRAM_DOMAIN } from "../config/env.js";
import { decodeToken, getRequestUser, ROLE_LEVEL, setRequestUser, type Role } from "../auth/auth.service.js";
import { getRequestProgram, resolveProgramKey } from "./partition.middleware.js";

function readTokenFromCookieHeader(cookieHeader?: string): string | undefined {
  if (!cookieHeader) return undefined;
  const cookies = cookieHeader.split(";");
  for (const item of cookies) {
    const [rawKey, ...rawValue] = item.trim().split("=");
    const key = rawKey?.trim();
    if (!key) continue;
    if (["token", "accessToken", "authToken", "jwt", "session"].includes(key)) {
      return decodeURIComponent(rawValue.join("=") || "");
    }
  }
  return undefined;
}

function extractToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  return readTokenFromCookieHeader(req.headers.cookie);
}

export function tryAttachAuthUser(req: Request): boolean {
  const token = extractToken(req);
  if (!token) return false;
  try {
    const payload = decodeToken(token);
    if (!payload.organizationId || !payload.programDomain) {
      return false;
    }
    const partitionHeader =
      typeof req.headers["x-app-partition"] === "string"
        ? req.headers["x-app-partition"]
        : undefined;
    const requestProgram = getRequestProgram(req)?.key || resolveProgramKey(partitionHeader) || CURRENT_PROGRAM_DOMAIN;
    if (payload.programDomain !== requestProgram) {
      return false;
    }
    setRequestUser(req, payload);
    return true;
  } catch {
    return false;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!tryAttachAuthUser(req)) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
}

export function requireRole(minRole: Role) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = getRequestUser(req);
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const userLevel = ROLE_LEVEL[user.role as Role] ?? 0;
    const requiredLevel = ROLE_LEVEL[minRole];
    if (userLevel < requiredLevel) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    next();
  };
}

// ─── Eventure Role Helpers ────────────────────────────────────────────────────

import { prisma } from "../db/prisma.js";

/**
 * Verifies the authenticated user has an active EventurePersonnel record
 * for their organization. Attaches nothing — downstream handlers can re-query
 * if they need the personnel record.
 */
export function requireEventurePersonnel(req: Request, res: Response, next: NextFunction): void {
  const user = getRequestUser(req);
  if (!user) { res.status(401).json({ error: "Authentication required" }); return; }

  prisma.eventurePersonnel
    .findFirst({ where: { userId: user.userId, organizationId: user.organizationId, archivedAt: null } })
    .then((personnel) => {
      if (!personnel) { res.status(403).json({ error: "Eventure personnel access required" }); return; }
      next();
    })
    .catch(() => res.status(500).json({ error: "Internal server error" }));
}

/**
 * Restricts to users who are program_director for the org.
 * Only needed for endpoints that should be org-director–only.
 */
export function requireEventureProgramDirector(req: Request, res: Response, next: NextFunction): void {
  const user = getRequestUser(req);
  if (!user) { res.status(401).json({ error: "Authentication required" }); return; }

  prisma.eventurePersonnel
    .findFirst({
      where: { userId: user.userId, organizationId: user.organizationId, programRole: "program_director", archivedAt: null },
    })
    .then((personnel) => {
      if (!personnel) { res.status(403).json({ error: "Program Director access required" }); return; }
      next();
    })
    .catch(() => res.status(500).json({ error: "Internal server error" }));
}

/**
 * Factory: requires the user to have at least the given eventRole for the event
 * identified by :eventId in the route params.
 * Role hierarchy: event_manager > event_operator
 */
const EVENT_ROLE_LEVEL: Record<string, number> = {
  event_operator: 1,
  event_manager: 2,
};

export function requireEventureEventRole(minRole: "event_manager" | "event_operator") {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = getRequestUser(req);
    if (!user) { res.status(401).json({ error: "Authentication required" }); return; }

    const eventId = (req.params as Record<string, string>).eventId;
    if (!eventId) { res.status(400).json({ error: "eventId required" }); return; }

    // org admins always pass through
    if ((ROLE_LEVEL[user.role as Role] ?? 0) >= ROLE_LEVEL["admin"]) { next(); return; }

    prisma.eventureEventPersonnel
      .findFirst({
        where: {
          eventId,
          organizationId: user.organizationId,
          archivedAt: null,
          personnel: { userId: user.userId },
        },
      })
      .then((assignment) => {
        if (!assignment) { res.status(403).json({ error: "Event access required" }); return; }
        const userLevel = EVENT_ROLE_LEVEL[assignment.eventRole] ?? 0;
        const requiredLevel = EVENT_ROLE_LEVEL[minRole] ?? 0;
        if (userLevel < requiredLevel) { res.status(403).json({ error: "Insufficient event role" }); return; }
        next();
      })
      .catch(() => res.status(500).json({ error: "Internal server error" }));
  };
}
