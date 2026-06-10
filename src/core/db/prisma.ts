import { PrismaClient } from "@prisma/client";

type EventureInviteDelegate = {
	create(args: any): Promise<any>;
	findFirst(args: any): Promise<any>;
	findUnique(args: any): Promise<any>;
	update(args: any): Promise<any>;
	delete(args: any): Promise<any>;
};

type EventurePersonnelDelegate = {
	update(args: any): Promise<any>;
};

type EventurePrismaClient = PrismaClient & {
	eventureInvite: EventureInviteDelegate;
	eventurePersonnel: EventurePersonnelDelegate;
};

export const prisma = new PrismaClient() as unknown as EventurePrismaClient;
