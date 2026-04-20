/**
 * Partitions the community-chronicle program for the existing
 * Nxt Lvl Technology Solutions account.
 *
 * Run: node scripts/seed-community-chronicle-partition.js
 *
 * What this does:
 *  1. Looks up the existing org by slug
 *  2. Looks up the existing user by email
 *  3. Upserts OrganizationProgramAccess  → org can use community-chronicle
 *  4. Upserts OrganizationProgramSubscription → org is "active" on community-chronicle
 *  5. Upserts ProgramStorageSettings     → links org+program to the R2 bucket
 *  6. Upserts UserProgramAccess          → John Steele has access
 *
 * After running, set these env vars in nxt-lvl-api's .env:
 *   DEFAULT_ORGANIZATION_ID=<printed org id>
 *   CURRENT_PROGRAM_DOMAIN=community-chronicle
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const PROGRAM_ID = "community-chronicle";
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

  // 3. Storage settings — points to the community-chronicle R2 bucket
  await prisma.programStorageSettings.upsert({
    where: {
      organizationId_programDomain: {
        organizationId: org.id,
        programDomain: PROGRAM_ID,
      },
    },
    update: {
      settings: {
        provider: "r2",
        bucket: "community-chronicle",
        region: "auto",
      },
    },
    create: {
      organizationId: org.id,
      programDomain: PROGRAM_ID,
      settings: {
        provider: "r2",
        bucket: "community-chronicle",
        region: "auto",
      },
    },
  });

  // 4. User-level program access
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

  console.log("✅ community-chronicle partition seeded");
  console.log("");
  console.log("Add to nxt-lvl-api .env:");
  console.log(`  DEFAULT_ORGANIZATION_ID=${org.id}`);
  console.log(`  CURRENT_PROGRAM_DOMAIN=${PROGRAM_ID}`);
  console.log("");
  console.log("Partition details:");
  console.log(`  org.id:       ${org.id}`);
  console.log(`  org.slug:     ${org.slug}`);
  console.log(`  user.id:      ${user.id}`);
  console.log(`  user.email:   ${user.email}`);
  console.log(`  programId:    ${PROGRAM_ID}`);
  console.log(`  bucket:       community-chronicle (R2)`);
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
