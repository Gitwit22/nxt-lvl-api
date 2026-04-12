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
    findMany: (args: Record<string, unknown>) => Promise<Array<{ id: string; programId: string; status: string }>>;
  };
};

const prismaExt = prisma as PrismaWithSubscription;

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
