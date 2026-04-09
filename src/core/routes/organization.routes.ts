import express from "express";
import { prisma } from "../db/prisma.js";
import { requireAuth } from "../middleware/auth.middleware.js";

const router = express.Router();

router.get("/:orgId/users", requireAuth, async (req, res) => {
  const orgIdParam = req.params.orgId;
  const orgId = Array.isArray(orgIdParam) ? orgIdParam[0] : orgIdParam;

  if (!orgId) {
    res.status(400).json({ error: "Organization id is required" });
    return;
  }

  try {
    const members = await prisma.membership.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: "asc" },
      select: {
        userId: true,
        role: true,
      },
    });

    if (members.length > 0) {
      const userIds = members.map((entry) => entry.userId);
      const users = await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      const userById = new Map(users.map((u) => [u.id, u]));
      res.json(
        members
          .map((entry) => {
            const user = userById.get(entry.userId);
            if (!user) return null;
            return {
              id: user.id,
              email: user.email,
              firstName: user.firstName,
              lastName: user.lastName,
              isActive: user.isActive,
              role: entry.role,
              organizationId: orgId,
              createdAt: user.createdAt,
              updatedAt: user.updatedAt,
            };
          })
          .filter((row): row is NonNullable<typeof row> => row !== null),
      );
      return;
    }

    // Fallback for datasets where membership rows are not populated.
    const users = await prisma.user.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        isActive: true,
        role: true,
        organizationId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json(users);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch organization users";
    res.status(500).json({ error: message });
  }
});

export { router as organizationRouter };
