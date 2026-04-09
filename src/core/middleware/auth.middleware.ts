import type { NextFunction, Request, Response } from "express";
import { CURRENT_PROGRAM_DOMAIN } from "../config/env.js";
import { decodeToken, getRequestUser, ROLE_LEVEL, setRequestUser, type Role } from "../auth/auth.service.js";

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
    if (payload.programDomain !== CURRENT_PROGRAM_DOMAIN) {
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
