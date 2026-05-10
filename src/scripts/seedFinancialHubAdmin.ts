import { prisma } from "../core/db/prisma.js";
import bcrypt from "bcryptjs";

const PROGRAM_ID = "financial-hub";
const EMAIL = "nxtlvltechllc@gmail.com";
const PASSWORD = "4755Dett";
const DISPLAY_NAME = "Nxt Lvl Tech LLC";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

async function ensureFinancialHubOrganization() {
  const existingSub = await prisma.organizationProgramSubscription.findFirst({
    where: {
      programId: PROGRAM_ID,
      status: { in: ["active", "trialing"] },
    },
    orderBy: { createdAt: "asc" },
  });

  if (existingSub) {
    const org = await prisma.organization.findUnique({ where: { id: existingSub.organizationId } });
    if (!org) {
      throw new Error(`Subscription ${existingSub.id} references missing organization ${existingSub.organizationId}`);
    }
    return org;
  }

  const baseName = "Nxt Lvl Technology Solutions";
  const org = await prisma.organization.create({
    data: {
      name: baseName,
      slug: `${slugify(baseName)}-${Date.now().toString(36)}`,
      ownerEmail: EMAIL,
      contactEmail: EMAIL,
      supportEmail: EMAIL,
      status: "active",
      isActive: true,
    },
  });

  await prisma.organizationProgramSubscription.create({
    data: {
      organizationId: org.id,
      programId: PROGRAM_ID,
      status: "active",
      subscriptionSource: "manual",
      startsAt: new Date(),
      notes: "Created by Financial Hub seed script",
    },
  });

  return org;
}

async function main() {
  const org = await ensureFinancialHubOrganization();
  const passwordHash = await bcrypt.hash(PASSWORD, 12);

  const user = await prisma.user.upsert({
    where: { email: EMAIL },
    update: {
      organizationId: org.id,
      displayName: DISPLAY_NAME,
      role: "admin",
      platformRole: "user",
      passwordHash,
      mustChangePassword: false,
      passwordSetAt: new Date(),
      isActive: true,
      identitySource: "local",
    },
    create: {
      organizationId: org.id,
      email: EMAIL,
      displayName: DISPLAY_NAME,
      firstName: "Nxt",
      lastName: "Lvl Tech LLC",
      role: "admin",
      platformRole: "user",
      passwordHash,
      isActive: true,
      identitySource: "local",
    },
  });

  await prisma.membership.upsert({
    where: {
      userId_organizationId: {
        userId: user.id,
        organizationId: org.id,
      },
    },
    update: { role: "owner" },
    create: {
      userId: user.id,
      organizationId: org.id,
      role: "owner",
    },
  });

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

  await prisma.organizationProgramSubscription.upsert({
    where: {
      organizationId_programId: {
        organizationId: org.id,
        programId: PROGRAM_ID,
      },
    },
    update: {
      status: "active",
      startsAt: new Date(),
    },
    create: {
      organizationId: org.id,
      programId: PROGRAM_ID,
      status: "active",
      subscriptionSource: "manual",
      startsAt: new Date(),
    },
  });

  await prisma.programStorageSettings.upsert({
    where: {
      organizationId_programDomain: {
        organizationId: org.id,
        programDomain: PROGRAM_ID,
      },
    },
    update: {
      settings: {
        seededBy: "seedFinancialHubAdmin",
      },
    },
    create: {
      organizationId: org.id,
      programDomain: PROGRAM_ID,
      settings: {
        seededBy: "seedFinancialHubAdmin",
      },
    },
  });

  const prismaFinancial = prisma as typeof prisma & {
    financialHubUserProfile: {
      upsert: (args: Record<string, unknown>) => Promise<unknown>;
    };
  };

  await prismaFinancial.financialHubUserProfile.upsert({
    where: {
      organizationId_programDomain_userId: {
        organizationId: org.id,
        programDomain: PROGRAM_ID,
        userId: user.id,
      },
    },
    update: {
      title: "Owner",
      defaultTimezone: "America/New_York",
      isInitialAdmin: true,
      capabilities: {
        canManageFinanceSettings: true,
        canReviewFinanceIntake: true,
        canApproveFinanceReady: true,
        canExportFinanceData: true,
        canManageUsers: true,
        canViewReports: true,
        canManageOrganization: true,
      },
      createdByUserId: user.id,
    },
    create: {
      userId: user.id,
      organizationId: org.id,
      programDomain: PROGRAM_ID,
      title: "Owner",
      defaultTimezone: "America/New_York",
      isInitialAdmin: true,
      capabilities: {
        canManageFinanceSettings: true,
        canReviewFinanceIntake: true,
        canApproveFinanceReady: true,
        canExportFinanceData: true,
        canManageUsers: true,
        canViewReports: true,
        canManageOrganization: true,
      },
      createdByUserId: user.id,
    },
  });

  console.log("Financial Hub login seeded successfully", {
    email: EMAIL,
    organizationId: org.id,
    userId: user.id,
    programDomain: PROGRAM_ID,
  });
}

main()
  .catch((error) => {
    console.error("Failed to seed Financial Hub login", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
