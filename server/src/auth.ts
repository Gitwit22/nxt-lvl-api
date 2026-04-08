import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import type { Request, Response, NextFunction } from "express";
import {
  CURRENT_PROGRAM_DOMAIN,
  DEFAULT_ORGANIZATION_ID,
  JWT_SECRET,
  JWT_EXPIRES_IN,
} from "./config.js";

export interface AuthTokenPayload {
  userId: string;
  email: string;
  role: string;
  organizationId: string;
  programDomain: string;
}

type SignableAuthTokenPayload = Omit<AuthTokenPayload, "organizationId" | "programDomain"> &
  Partial<Pick<AuthTokenPayload, "organizationId" | "programDomain">>;

// Typed role hierarchy
type Role = "uploader" | "reviewer" | "admin";
const ROLE_LEVEL: Record<Role, number> = { uploader: 1, reviewer: 2, admin: 3 };

// --- Password helpers ---

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, 12);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

// --- Token helpers ---

export function signToken(payload: SignableAuthTokenPayload): string {
  return jwt.sign(
    {
      ...payload,
      organizationId: payload.organizationId || DEFAULT_ORGANIZATION_ID,
      programDomain: payload.programDomain || CURRENT_PROGRAM_DOMAIN,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions,
  );
}

export function decodeToken(token: string): AuthTokenPayload {
  return jwt.verify(token, JWT_SECRET) as AuthTokenPayload;
}

// --- Request helpers (avoids global augmentation complexity) ---

export function getRequestUser(req: Request): AuthTokenPayload | undefined {
  return (req as unknown as { _authUser?: AuthTokenPayload })._authUser;
}

function setRequestUser(req: Request, user: AuthTokenPayload): void {
  (req as unknown as { _authUser: AuthTokenPayload })._authUser = user;
}

// --- Middleware ---

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
