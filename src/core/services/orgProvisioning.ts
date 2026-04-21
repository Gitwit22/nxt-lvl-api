/**
 * Org Provisioning Service
 *
 * Idempotent helpers that ensure an organization has the correct
 * OrganizationProgramSubscription rows for every program in its
 * assignedProgramIds list.
 *
 * Safe to call multiple times — uses upsert semantics so existing
 * active subscriptions are never downgraded.
 */
import { prisma } from "../db/prisma.js";
import { logger } from "../../logger.js";

type PrismaWithSubscription = typeof prisma & {
  organizationProgramSubscription: {
    findFirst: (args: Record<string, unknown>) => Promise<{ id: string; status: string } | null>;
    create: (args: Record<string, unknown>) => Promise<{ id: string }>;
    update: (args: Record<string, unknown>) => Promise<{ id: string }>;
    upsert: (args: Record<string, unknown>) => Promise<{ id: string }>;
    findMany: (args: Record<string, unknown>) => Promise<Array<{ id: string; programId: string; status: string }>>;
  };
};

const prismaExt = prisma as PrismaWithSubscription;

type PrismaWithProgramAccess = typeof prisma & {
  organizationProgramAccess: {
    upsert: (args: Record<string, unknown>) => Promise<{ id: string }>;
  };
  programStorageSettings: {
    upsert: (args: Record<string, unknown>) => Promise<{ id: string }>;
  };
  userProgramAccess: {
    upsert: (args: Record<string, unknown>) => Promise<{ id: string }>;
  };
  organizationProgramSubscription: {
    findMany: (args: Record<string, unknown>) => Promise<Array<{ programId: string }>>;
  };
};

const prismaProgramAccess = prisma as PrismaWithProgramAccess;

const COMMUNITY_CHRONICLE_PROGRAM_ID = "community-chronicle";
const COMMUNITY_CHRONICLE_STORAGE_SETTINGS = {
  provider: "r2",
  bucket: "community-chronicle",
  region: "auto",
};

/**
 * Ensure that the given org has an active subscription for each programId.
 * - Creates missing rows with status = "active"
 * - Activates rows that exist but are "inactive" or "canceled"
 * - Leaves "trialing", "active", and "past_due" rows untouched
 *
 * Returns counts of created / activated / skipped rows.
 */
export async function provisionOrgSubscriptions(
  organizationId: string,
  programIds: string[],
): Promise<{ created: number; activated: number; skipped: number }> {
  if (programIds.length === 0) {
    return { created: 0, activated: 0, skipped: 0 };
  }

  let created = 0;
  let activated = 0;
  let skipped = 0;

  for (const programId of programIds) {
    if (!programId?.trim()) continue;

    const existing = await prismaExt.organizationProgramSubscription.findFirst({
      where: { organizationId, programId } as Record<string, unknown>,
    });

    if (!existing) {
      await prismaExt.organizationProgramSubscription.create({
        data: {
          organizationId,
          programId,
          status: "active",
          subscriptionSource: "manual",
          startsAt: new Date(),
          notes: "Auto-provisioned from assignedProgramIds",
        } as Record<string, unknown>,
      });
      created++;
      logger.info("[provision] subscription created", { organizationId, programId });
    } else if (existing.status === "inactive" || existing.status === "canceled") {
      await prismaExt.organizationProgramSubscription.update({
        where: { id: existing.id } as Record<string, unknown>,
        data: { status: "active", startsAt: new Date() } as Record<string, unknown>,
      });
      activated++;
      logger.info("[provision] subscription activated", { organizationId, programId, was: existing.status });
    } else {
      skipped++;
    }
  }

  return { created, activated, skipped };
}

/**
 * Read the org's assignedProgramIds from the DB and provision subscriptions for all of them.
 * This is the "full backfill" path used by the provision endpoint and first-run bootstrap.
 */
export async function provisionOrgFromAssignedIds(organizationId: string): Promise<{
  created: number;
  activated: number;
  skipped: number;
  programIds: string[];
}> {
  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (!org) {
    throw new Error(`Organization ${organizationId} not found`);
  }

  const raw = org.assignedProgramIds;
  const programIds = Array.isArray(raw) ? (raw as string[]).filter((id) => typeof id === "string" && id.trim()) : [];

  const counts = await provisionOrgSubscriptions(organizationId, programIds);
  return { ...counts, programIds };
}

/**
 * Provision the default community-chronicle partition for an organization.
 * This guarantees org-level access, active subscription, and storage settings.
 * Optionally grants direct user access for a specific user in that org.
 */
export async function provisionCommunityChroniclePartition(
  organizationId: string,
  userId?: string,
): Promise<void> {
  await prismaProgramAccess.organizationProgramAccess.upsert({
    where: {
      organizationId_programId: {
        organizationId,
        programId: COMMUNITY_CHRONICLE_PROGRAM_ID,
      },
    } as Record<string, unknown>,
    update: { enabled: true } as Record<string, unknown>,
    create: {
      organizationId,
      programId: COMMUNITY_CHRONICLE_PROGRAM_ID,
      enabled: true,
    } as Record<string, unknown>,
  });

  await prismaExt.organizationProgramSubscription.upsert({
    where: {
      organizationId_programId: {
        organizationId,
        programId: COMMUNITY_CHRONICLE_PROGRAM_ID,
      },
    } as Record<string, unknown>,
    update: {
      status: "active",
      subscriptionSource: "manual",
      startsAt: new Date(),
      notes: "Auto-provisioned default partition",
    } as Record<string, unknown>,
    create: {
      organizationId,
      programId: COMMUNITY_CHRONICLE_PROGRAM_ID,
      status: "active",
      subscriptionSource: "manual",
      startsAt: new Date(),
      notes: "Auto-provisioned default partition",
    } as Record<string, unknown>,
  });

  await prismaProgramAccess.programStorageSettings.upsert({
    where: {
      organizationId_programDomain: {
        organizationId,
        programDomain: COMMUNITY_CHRONICLE_PROGRAM_ID,
      },
    } as Record<string, unknown>,
    update: {
      settings: COMMUNITY_CHRONICLE_STORAGE_SETTINGS,
    } as Record<string, unknown>,
    create: {
      organizationId,
      programDomain: COMMUNITY_CHRONICLE_PROGRAM_ID,
      settings: COMMUNITY_CHRONICLE_STORAGE_SETTINGS,
    } as Record<string, unknown>,
  });

  if (userId) {
    await prismaProgramAccess.userProgramAccess.upsert({
      where: {
        userId_organizationId_programId: {
          userId,
          organizationId,
          programId: COMMUNITY_CHRONICLE_PROGRAM_ID,
        },
      } as Record<string, unknown>,
      update: { enabled: true } as Record<string, unknown>,
      create: {
        userId,
        organizationId,
        programId: COMMUNITY_CHRONICLE_PROGRAM_ID,
        enabled: true,
      } as Record<string, unknown>,
    });
  }

  logger.info("[provision] community-chronicle partition ensured", {
    organizationId,
    userId: userId ?? null,
  });
}

/**
 * Grants user-level access rows for all active/trialing subscriptions
 * already assigned to an organization.
 */
export async function provisionUserProgramAccessFromOrgSubscriptions(
  organizationId: string,
  userId: string,
): Promise<{ granted: number }> {
  const subscriptions = await prisma.organizationProgramSubscription.findMany({
    where: {
      organizationId,
      status: { in: ["active", "trialing"] },
    },
    select: { programId: true },
  });

  let granted = 0;
  for (const sub of subscriptions) {
    const programId = sub.programId.trim();
    if (!programId) continue;

    await prismaProgramAccess.userProgramAccess.upsert({
      where: {
        userId_organizationId_programId: {
          userId,
          organizationId,
          programId,
        },
      } as Record<string, unknown>,
      update: { enabled: true } as Record<string, unknown>,
      create: {
        userId,
        organizationId,
        programId,
        enabled: true,
      } as Record<string, unknown>,
    });
    granted++;
  }

  return { granted };
}
