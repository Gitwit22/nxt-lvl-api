import { prisma } from "../../../core/db/prisma.js";

export type EventureEventRecord = Awaited<ReturnType<typeof prisma.eventureEvent.findFirst>>;

export type CreateEventureEventInput = {
  organizationId: string;
  title: string;
  description?: string;
  eventType?: string;
  status?: string;
  startDateTime: Date;
  endDateTime: Date;
  timezone?: string;
  venueName: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  capacity?: number;
  expectedAttendance?: number;
  linkedProgramId?: string;
  linkedCampaignId?: string;
  linkedSponsorId?: string;
  notes?: string;
  createdByUserId: string;
};

export type UpdateEventureEventInput = Partial<Omit<CreateEventureEventInput, "organizationId" | "createdByUserId">> & {
  archivedAt?: Date | null;
};

export async function listEventureEvents(organizationId: string) {
  return prisma.eventureEvent.findMany({
    where: {
      organizationId,
      archivedAt: null,
    },
    orderBy: [{ startDateTime: "asc" }, { createdAt: "desc" }],
  });
}

export async function createEventureEvent(input: CreateEventureEventInput) {
  return prisma.eventureEvent.create({
    data: {
      organizationId: input.organizationId,
      title: input.title,
      description: input.description,
      eventType: input.eventType ?? "general",
      status: input.status ?? "draft",
      startDateTime: input.startDateTime,
      endDateTime: input.endDateTime,
      timezone: input.timezone ?? "America/New_York",
      venueName: input.venueName,
      addressLine1: input.addressLine1,
      addressLine2: input.addressLine2,
      city: input.city,
      state: input.state,
      zipCode: input.zipCode,
      capacity: input.capacity,
      expectedAttendance: input.expectedAttendance,
      linkedProgramId: input.linkedProgramId,
      linkedCampaignId: input.linkedCampaignId,
      linkedSponsorId: input.linkedSponsorId,
      notes: input.notes,
      createdByUserId: input.createdByUserId,
    },
  });
}

export async function getEventureEventById(organizationId: string, eventId: string) {
  return prisma.eventureEvent.findFirst({
    where: {
      id: eventId,
      organizationId,
      archivedAt: null,
    },
    include: {
      _count: {
        select: {
          registrations: true,
          vendors: true,
          importBatches: true,
          checkInLogs: true,
          ticketTypes: true,
        },
      },
    },
  });
}

export async function updateEventureEvent(organizationId: string, eventId: string, input: UpdateEventureEventInput) {
  return prisma.eventureEvent.updateMany({
    where: {
      id: eventId,
      organizationId,
      archivedAt: null,
    },
    data: {
      title: input.title,
      description: input.description,
      eventType: input.eventType,
      status: input.status,
      startDateTime: input.startDateTime,
      endDateTime: input.endDateTime,
      timezone: input.timezone,
      venueName: input.venueName,
      addressLine1: input.addressLine1,
      addressLine2: input.addressLine2,
      city: input.city,
      state: input.state,
      zipCode: input.zipCode,
      capacity: input.capacity,
      expectedAttendance: input.expectedAttendance,
      linkedProgramId: input.linkedProgramId,
      linkedCampaignId: input.linkedCampaignId,
      linkedSponsorId: input.linkedSponsorId,
      notes: input.notes,
      archivedAt: input.archivedAt,
    },
  });
}