/**
 * Partitions the eventure program for the existing
 * Nxt Lvl Technology Solutions account.
 *
 * Run: node scripts/seed-eventure-partition.js
 *
 * What this does:
 *  1. Looks up the existing org by slug
 *  2. Looks up the existing user by email
 *  3. Upserts OrganizationProgramAccess  → org can use eventure
 *  4. Upserts OrganizationProgramSubscription → org is "active" on eventure
 *  5. Upserts UserProgramAccess          → user has access
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const PROGRAM_ID = "eventure";
const ORG_SLUG = "nxt-lvl-technology-solutions";
const USER_EMAIL = "nxtlvltechllc@gmail.com";

async function main() {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { slug: ORG_SLUG },
  });

  const user = await prisma.user.findUniqueOrThrow({
    where: { email: USER_EMAIL },
  });

  // 1. Org-level program access
  await prisma.organizationProgramAccess.upsert({
    where: {
      organizationId_programId: {
        organizationId: org.id,
        programId: PROGRAM_ID,
      },
    },
    update: { enabled: true },
    create: {
      organizationId: org.id,
      programId: PROGRAM_ID,
      enabled: true,
    },
  });

  // 2. Subscription record (active)
  await prisma.organizationProgramSubscription.upsert({
    where: {
      organizationId_programId: {
        organizationId: org.id,
        programId: PROGRAM_ID,
      },
    },
    update: {
      status: "active",
      subscriptionSource: "manual",
    },
    create: {
      organizationId: org.id,
      programId: PROGRAM_ID,
      status: "active",
      subscriptionSource: "manual",
      notes: "Owner account — manually provisioned",
    },
  });

  // 3. User-level program access
  await prisma.userProgramAccess.upsert({
    where: {
      userId_organizationId_programId: {
        userId: user.id,
        organizationId: org.id,
        programId: PROGRAM_ID,
      },
    },
    update: { enabled: true },
    create: {
      userId: user.id,
      organizationId: org.id,
      programId: PROGRAM_ID,
      enabled: true,
    },
  });

  console.log("✅ eventure partition seeded");
  console.log("");
  console.log("Partition details:");
  console.log(`  org.id:       ${org.id}`);
  console.log(`  org.slug:     ${org.slug}`);
  console.log(`  user.id:      ${user.id}`);
  console.log(`  user.email:   ${user.email}`);
  console.log(`  programId:    ${PROGRAM_ID}`);
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
