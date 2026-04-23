import express from "express";
import { prisma } from "../db/prisma.js";
import {
  PLATFORM_DISPLAY_NAME,
  PLATFORM_SYSTEM_NAME,
  HEALTH_SYSTEM_TOKEN,
} from "../config/env.js";
import {
  runSystemHealthChecks,
} from "../health/systemHealth.js";

const router = express.Router();

function isSystemHealthAuthorized(authHeader: string | undefined, headerToken: string | undefined): boolean {
  if (!HEALTH_SYSTEM_TOKEN) return true;

  const providedHeaderToken = headerToken?.trim() || "";
  if (providedHeaderToken && providedHeaderToken === HEALTH_SYSTEM_TOKEN) {
    return true;
  }

  if (!authHeader) return false;
  if (!authHeader.startsWith("Bearer ")) return false;
  const bearerToken = authHeader.slice("Bearer ".length).trim();
  return bearerToken === HEALTH_SYSTEM_TOKEN;
}

router.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      ok: true,
      platform: PLATFORM_DISPLAY_NAME,
      systemName: PLATFORM_SYSTEM_NAME,
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({ ok: false, error: "Database unreachable" });
  }
});

router.get("/health/system", async (req, res) => {
  if (!isSystemHealthAuthorized(req.headers.authorization, req.header("x-health-token"))) {
    res.status(401).json({
      ok: false,
      status: "down",
      error: "Unauthorized system health check request",
    });
    return;
  }

  const result = await runSystemHealthChecks();

  const statusCode = result.status === "down" ? 503 : 200;
  res.status(statusCode).json(result);
});

export { router as healthRouter };
