import express from "express";
import { prisma } from "../db/prisma.js";
import { DEFAULT_ORGANIZATION_ID } from "../config/env.js";
import { programs } from "../config/programs.js";

const router = express.Router();

router.get("/run", (_req, res) => {
  res.json({ ok: true });
});

router.get("/programs", (_req, res) => {
  const list = Object.entries(programs).map(([key, program]) => ({
    id: key,
    key,
    slug: key,
    name: program.displayName,
    routePrefix: program.routePrefix,
  }));
  res.json(list);
});

router.get("/orgs", async (_req, res) => {
  try {
    const rows = await prisma.organization.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        isActive: true,
      },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    if (rows.length > 0) {
      res.json(rows);
      return;
    }
  } catch {
    // Fallback for environments where org table is unavailable.
  }

  res.json([
    {
      id: DEFAULT_ORGANIZATION_ID,
      name: "Default Organization",
      slug: DEFAULT_ORGANIZATION_ID,
      isActive: true,
    },
  ]);
});

export { router as shellRouter };
