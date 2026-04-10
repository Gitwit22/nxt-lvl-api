import express from "express";
import {
  CURRENT_PROGRAM_DOMAIN,
  PLATFORM_API_BASE_URL,
  PLATFORM_AUTH_TIMEOUT_MS,
  PLATFORM_VALIDATE_LAUNCH_URL,
} from "../config/env.js";
import { signToken } from "../auth/auth.service.js";
import { prisma } from "../db/prisma.js";
import { logger } from "../../logger.js";

const router = express.Router();

type LaunchClaims = {
  userId: string;
  email: string;
  role: string;
  organizationId: string;
  programDomain?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return undefined;
}

function normalizeRole(input: unknown): string {
  const value = typeof input === "string" ? input.toLowerCase().trim() : "";
  const roleAliasMap: Record<string, string> = {
    "executive director": "admin",
    "deputy director": "reviewer",
    finance: "reviewer",
    admin: "admin",
  };

  if (roleAliasMap[value]) {
    return roleAliasMap[value];
  }

  if (["admin", "reviewer", "uploader"].includes(value)) {
    return value;
  }
  return "uploader";
}

function readLaunchClaims(payload: unknown): LaunchClaims | undefined {
  if (!isRecord(payload)) return undefined;

  const user = isRecord(payload.user) ? payload.user : undefined;
  const launch = isRecord(payload.launch) ? payload.launch : undefined;
  const claims = isRecord(payload.claims) ? payload.claims : undefined;

  const userId = firstString(
    payload.userId,
    payload.id,
    user?.id,
    launch?.userId,
    claims?.userId,
    claims?.sub,
  );
  const email = firstString(payload.email, user?.email, launch?.email, claims?.email);
  const role = normalizeRole(payload.role ?? user?.role ?? launch?.role ?? claims?.role);
  const organizationId = firstString(
    payload.organizationId,
    user?.organizationId,
    launch?.organizationId,
    claims?.organizationId,
    claims?.orgId,
  );
  const programDomain = firstString(
    payload.programDomain,
    user?.programDomain,
    launch?.programDomain,
    claims?.programDomain,
  );

  if (!userId || !email || !organizationId) {
    return undefined;
  }

  return {
    userId,
    email,
    role,
    organizationId,
    programDomain,
  };
}

function resolveValidateLaunchUrl(): string {
  if (PLATFORM_VALIDATE_LAUNCH_URL) {
    return PLATFORM_VALIDATE_LAUNCH_URL;
  }
  if (PLATFORM_API_BASE_URL) {
    return `${PLATFORM_API_BASE_URL.replace(/\/$/, "")}/api/auth/validate-launch`;
  }
  return "";
}

function readErrorMessage(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  return firstString(payload.error, payload.message, payload.detail);
}

router.post("/consume", async (req, res) => {
  const body = isRecord(req.body) ? req.body : {};
  const launchToken = firstString(
    body.launchToken,
    body.token,
    body.accessToken,
    body.authToken,
    body.launch_token,
  );

  if (!launchToken) {
    res.status(400).json({ error: "launchToken is required" });
    return;
  }

  const validateLaunchUrl = resolveValidateLaunchUrl();
  if (!validateLaunchUrl) {
    res.status(503).json({
      error: "Platform auth service unavailable",
      code: "platform_unavailable",
      detail: "Platform validation URL is not configured",
    });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PLATFORM_AUTH_TIMEOUT_MS);

  let validateResponse: Response;
  let validatePayload: unknown;

  try {
    validateResponse = await fetch(validateLaunchUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        launchToken,
        token: launchToken,
        expectedProgramDomain: CURRENT_PROGRAM_DOMAIN,
        programDomain: CURRENT_PROGRAM_DOMAIN,
      }),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeout);
    res.status(503).json({
      error: "Platform auth service unavailable",
      code: "platform_unavailable",
      detail: "Unable to reach platform validation endpoint",
    });
    return;
  }

  clearTimeout(timeout);

  try {
    validatePayload = await validateResponse.json();
  } catch {
    validatePayload = undefined;
  }

  if (validateResponse.status >= 500) {
    res.status(503).json({
      error: "Platform auth service unavailable",
      code: "platform_unavailable",
      detail: "Platform validation endpoint returned a server error",
    });
    return;
  }

  if (!validateResponse.ok) {
    res.status(401).json({
      error: readErrorMessage(validatePayload) || "Invalid, expired, or mismatched launch token",
      code: "invalid_launch_token",
    });
    return;
  }

  const claims = readLaunchClaims(validatePayload);
  if (!claims) {
    res.status(401).json({
      error: "Invalid, expired, or mismatched launch token",
      code: "invalid_launch_token",
    });
    return;
  }

  if (claims.programDomain && claims.programDomain !== CURRENT_PROGRAM_DOMAIN) {
    res.status(401).json({
      error: "Launch token program does not match this API",
      code: "invalid_launch_token",
    });
    return;
  }

  // -------------------------------------------------------------------------
  // Find-or-create the Chronicle-local User record for this platform identity.
  // This ensures:
  //   1. The JWT userId references a real row in the Chronicle DB.
  //   2. Platform-linked users and local users are separately tracked.
  //   3. If a local user with the same (org, email) already exists, their
  //      platform identity is linked rather than creating a duplicate.
  // -------------------------------------------------------------------------
  const userStore = prisma as unknown as {
    user: {
      findFirst: (args: { where: Record<string, unknown> }) => Promise<Record<string, unknown> | null>;
      create: (args: { data: Record<string, unknown> }) => Promise<Record<string, unknown>>;
      update: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<Record<string, unknown>>;
    };
  };

  let chronicleUser = await userStore.user.findFirst({
    where: { platformUserId: claims.userId, identitySource: "platform" },
  });

  if (!chronicleUser) {
    // Check if a local user with the same org+email already exists (account linking)
    const existingByEmail = await userStore.user.findFirst({
      where: { organizationId: claims.organizationId, email: claims.email },
    });

    if (existingByEmail) {
      // Link the platform identity to the existing local user
      chronicleUser = await userStore.user.update({
        where: { id: existingByEmail.id as string },
        data: { platformUserId: claims.userId },
      });
      logger.info("Linked platform identity to existing Chronicle user", {
        chronicleUserId: chronicleUser.id,
        platformUserId: claims.userId,
        email: claims.email,
      });
    } else {
      // Create a new platform-linked Chronicle user
      chronicleUser = await userStore.user.create({
        data: {
          organizationId: claims.organizationId,
          email: claims.email,
          passwordHash: "",
          role: claims.role,
          displayName: (claims.email as string).split("@")[0] ?? claims.email,
          identitySource: "platform",
          platformUserId: claims.userId,
        },
      });
      logger.info("Created Chronicle user for platform identity", {
        chronicleUserId: chronicleUser.id,
        platformUserId: claims.userId,
        email: claims.email,
      });
    }
  }

  const chronicleToken = signToken({
    userId: chronicleUser.id as string,
    email: chronicleUser.email as string,
    role: chronicleUser.role as string,
    organizationId: chronicleUser.organizationId as string,
    programDomain: CURRENT_PROGRAM_DOMAIN,
  });

  const secureCookie = process.env.NODE_ENV === "production";
  res.cookie("accessToken", chronicleToken, {
    httpOnly: true,
    secure: secureCookie,
    sameSite: secureCookie ? "none" : "lax",
    maxAge: 8 * 60 * 60 * 1000,
    path: "/",
  });

  res.cookie("token", chronicleToken, {
    httpOnly: true,
    secure: secureCookie,
    sameSite: secureCookie ? "none" : "lax",
    maxAge: 8 * 60 * 60 * 1000,
    path: "/",
  });

  res.setHeader("Authorization", `Bearer ${chronicleToken}`);

  res.json({
    token: chronicleToken,
    accessToken: chronicleToken,
    authToken: chronicleToken,
    auth: { token: chronicleToken },
    data: { token: chronicleToken },
    user: {
      id: chronicleUser.id,
      email: chronicleUser.email,
      role: chronicleUser.role,
      organizationId: chronicleUser.organizationId,
      programDomain: CURRENT_PROGRAM_DOMAIN,
      identitySource: chronicleUser.identitySource,
    },
  });
});

export { router as platformAuthRouter };
