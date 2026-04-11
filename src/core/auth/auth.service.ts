import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { Request } from "express";
import {
  CURRENT_PROGRAM_DOMAIN,
  DEFAULT_ORGANIZATION_ID,
  JWT_SECRET,
  JWT_EXPIRES_IN,
} from "../config/env.js";

export interface AuthTokenPayload {
  userId: string;
  email: string;
  role: string;
  platformRole: string;
  organizationId: string;
  programDomain: string;
}

type SignableAuthTokenPayload = Omit<AuthTokenPayload, "organizationId" | "programDomain" | "platformRole"> &
  Partial<Pick<AuthTokenPayload, "organizationId" | "programDomain" | "platformRole">>;

export type Role = "uploader" | "reviewer" | "admin";

export const ROLE_LEVEL: Record<Role, number> = { uploader: 1, reviewer: 2, admin: 3 };

// Generates a 12-character random password using unambiguous characters.
// Intentionally excludes 0/O/l/1/I to prevent transcription errors.
export function generateTempPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(12);
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("");
}

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, 12);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

export function signToken(payload: SignableAuthTokenPayload): string {
  return jwt.sign(
    {
      ...payload,
      organizationId: payload.organizationId || DEFAULT_ORGANIZATION_ID,
      programDomain: payload.programDomain || CURRENT_PROGRAM_DOMAIN,
      platformRole: payload.platformRole || "user",
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions,
  );
}

export function decodeToken(token: string): AuthTokenPayload {
  return jwt.verify(token, JWT_SECRET) as AuthTokenPayload;
}

export function getRequestUser(req: Request): AuthTokenPayload | undefined {
  return (req as unknown as { _authUser?: AuthTokenPayload })._authUser;
}

export function setRequestUser(req: Request, user: AuthTokenPayload): void {
  (req as unknown as { _authUser: AuthTokenPayload })._authUser = user;
}
