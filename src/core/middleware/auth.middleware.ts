import type { NextFunction, Request, Response } from "express";
import { CURRENT_PROGRAM_DOMAIN } from "../config/env.js";
import { decodeToken, getRequestUser, ROLE_LEVEL, setRequestUser, type Role } from "../auth/auth.service.js";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const token = authHeader.slice(7);
  try {
    const payload = decodeToken(token);
    if (!payload.organizationId || !payload.programDomain) {
      res.status(401).json({ error: "Invalid tenant context" });
      return;
    }
    if (payload.programDomain !== CURRENT_PROGRAM_DOMAIN) {
      res.status(403).json({ error: "Program access denied" });
      return;
    }
    setRequestUser(req, payload);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
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
