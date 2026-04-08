import express from "express";
import { prisma } from "../db/prisma.js";
import { PLATFORM_DISPLAY_NAME, PLATFORM_SYSTEM_NAME } from "../config/env.js";

const router = express.Router();

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

export { router as healthRouter };
