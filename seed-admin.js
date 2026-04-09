import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const email = "nxtlvltechllc@gmail.com";
  const password = "ChangeMe123!";
  const orgSlug = "nxt-lvl-technology-solutions";
  const orgName = "Nxt Lvl Technology Solutions";

  const organization = await prisma.organization.upsert({
    where: { slug: orgSlug },
    update: {
      name: orgName,
      isActive: true,
    },
    create: {
      name: orgName,
      slug: orgSlug,
      isActive: true,
    },
  });

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.upsert({
    where: { email },
    update: {
      passwordHash,
      firstName: "John",
      lastName: "Steele",
      displayName: "John Steele",
      isActive: true,
      role: "admin",
      organizationId: organization.id,
    },
    create: {
      email,
      passwordHash,
      firstName: "John",
      lastName: "Steele",
      displayName: "John Steele",
      isActive: true,
      role: "admin",
      organizationId: organization.id,
    },
  });

  await prisma.membership.upsert({
    where: {
      userId_organizationId: {
        userId: user.id,
        organizationId: organization.id,
      },
    },
    update: {
      role: "owner",
    },
    create: {
      userId: user.id,
      organizationId: organization.id,
      role: "owner",
    },
  });

  console.log(
    JSON.stringify(
      {
        seeded: true,
        organization: {
          id: organization.id,
          slug: organization.slug,
          name: organization.name,
        },
        user: {
          id: user.id,
          email: user.email,
        },
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
