import {
  createEventureEvent,
  getEventureEventById,
  listEventureEvents,
  updateEventureEvent,
  type CreateEventureEventInput,
  type UpdateEventureEventInput,
} from "../repositories/event.repository.js";
import { EventureServiceError } from "./eventure-error.js";

function ensureDateOrder(startDateTime: Date, endDateTime: Date) {
  if (endDateTime <= startDateTime) {
    throw new EventureServiceError("endDateTime must be later than startDateTime.", 400);
  }
}

export async function listEventsForOrganization(organizationId: string) {
  return listEventureEvents(organizationId);
}

export async function createEventForOrganization(input: CreateEventureEventInput) {
  if (!input.title.trim()) {
    throw new EventureServiceError("title is required.", 400);
  }
  if (!input.venueName.trim()) {
    throw new EventureServiceError("venueName is required.", 400);
  }

  ensureDateOrder(input.startDateTime, input.endDateTime);

  return createEventureEvent(input);
}

export async function getEventForOrganization(organizationId: string, eventId: string) {
  const event = await getEventureEventById(organizationId, eventId);
  if (!event) {
    throw new EventureServiceError("Event not found.", 404);
  }
  return event;
}

export async function updateEventForOrganization(
  organizationId: string,
  eventId: string,
  input: UpdateEventureEventInput,
) {
  const current = await getEventureEventById(organizationId, eventId);
  if (!current) {
    throw new EventureServiceError("Event not found.", 404);
  }

  const nextStart = input.startDateTime ?? current.startDateTime;
  const nextEnd = input.endDateTime ?? current.endDateTime;
  ensureDateOrder(nextStart, nextEnd);

  const result = await updateEventureEvent(organizationId, eventId, input);
  if (result.count === 0) {
    throw new EventureServiceError("Event not found.", 404);
  }

  return getEventForOrganization(organizationId, eventId);
}

export async function archiveEventForOrganization(organizationId: string, eventId: string) {
  return updateEventForOrganization(organizationId, eventId, {
    status: "archived",
    archivedAt: new Date(),
  });
}