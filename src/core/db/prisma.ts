import { PrismaClient, Prisma } from "@prisma/client";

type EventurePrismaClient = PrismaClient & {
	eventureInvite: Prisma.EventureInviteDelegate<any, any>;
	eventurePersonnel: Prisma.EventurePersonnelDelegate<any, any>;
};

export const prisma = new PrismaClient() as EventurePrismaClient;
