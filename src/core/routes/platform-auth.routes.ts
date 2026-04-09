import express from "express";
import {
  CURRENT_PROGRAM_DOMAIN,
  PLATFORM_API_BASE_URL,
  PLATFORM_AUTH_TIMEOUT_MS,
  PLATFORM_VALIDATE_LAUNCH_URL,
} from "../config/env.js";
import { signToken } from "../auth/auth.service.js";

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

  const chronicleToken = signToken({
    userId: claims.userId,
    email: claims.email,
    role: claims.role,
    organizationId: claims.organizationId,
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
      id: claims.userId,
      email: claims.email,
      role: claims.role,
      organizationId: claims.organizationId,
      programDomain: CURRENT_PROGRAM_DOMAIN,
    },
  });
});

export { router as platformAuthRouter };
