import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import {
  archiveSponsorContactForEvent,
  archiveSponsorForEvent,
  createSponsorContactForEvent,
  createSponsorForEvent,
  getSponsorDashboardForEvent,
  getSponsorForEvent,
  listSponsorFollowUpsForEvent,
  listSponsorsForEvent,
  removeSponsorContactForEvent,
  removeSponsorForEvent,
  saveSponsorWithContactForEvent,
  updateSponsorContactForEvent,
  updateSponsorForEvent,
} from "../services/sponsor.service.js";
import { EventureServiceError } from "../services/eventure-error.js";

const router = express.Router({ mergeParams: true });

type SponsorOrganizationInput = {
  name?: string;
  mainEmail?: string | null;
  mainPhone?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  addressLine1?: string | null;
  website?: string | null;
  notes?: string | null;
};

type SponsorContactInput = {
  name?: string;
  email?: string | null;
  phone?: string | null;
  role?: string | null;
  isPrimary?: boolean;
};

function readRouteParam(value: unknown, fieldName: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new EventureServiceError(`${fieldName} is required.`, 400);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") {
    return value.trim();
  }
  throw new EventureServiceError("Expected a string value.", 400);
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readSponsorOrganizationInput(body: Record<string, unknown>): SponsorOrganizationInput | undefined {
  const source = isRecord(body.sponsorOrganization) ? body.sponsorOrganization : body;
  const name = readString(source.name);
  const mainEmail = readNullableString(source.mainEmail);
  const mainPhone = readNullableString(source.mainPhone);
  const city = readNullableString(source.city);
  const state = readNullableString(source.state);
  const zipCode = readNullableString(source.zipCode);
  const addressLine1 = readNullableString(source.addressLine1);
  const website = readNullableString(source.website);
  const notes = readNullableString(source.notes);

  if (
    name === undefined &&
    mainEmail === undefined &&
    mainPhone === undefined &&
    city === undefined &&
    state === undefined &&
    zipCode === undefined &&
    addressLine1 === undefined &&
    website === undefined &&
    notes === undefined
  ) {
    return undefined;
  }

  return {
    name,
    mainEmail,
    mainPhone,
    city,
    state,
    zipCode,
    addressLine1,
    website,
    notes,
  };
}

function readContactInput(body: Record<string, unknown>): SponsorContactInput | undefined {
  const source = isRecord(body.contact) ? body.contact : body;
  const name = readString(source.name ?? body.contactName);
  const email = readNullableString(source.email ?? body.contactEmail);
  const phone = readNullableString(source.phone ?? body.contactPhone);
  const role = readNullableString(source.role ?? body.contactRole);
  const isPrimary = readBoolean(source.isPrimary ?? body.contactIsPrimary);

  if (name === undefined && email === undefined && phone === undefined && role === undefined && isPrimary === undefined) {
    return undefined;
  }

  return {
    name,
    email,
    phone,
    role,
    isPrimary,
  };
}

function readSponsorPayload(body: unknown) {
  const source = isRecord(body) ? body : {};
  return {
    sponsorOrganizationId: readString(source.sponsorOrganizationId),
    sponsorOrganization: readSponsorOrganizationInput(source),
    sponsorshipPackage: readNullableString(source.sponsorshipPackage),
    committedAmount: readNumber(source.committedAmount),
    amountPaid: readNumber(source.amountPaid),
    paymentStatus: readString(source.paymentStatus),
    paymentNotes: readNullableString(source.paymentNotes),
    flightPreference: readNullableString(source.flightPreference),
    logoStatus: readNullableString(source.logoStatus),
    attendeeNamesRaw: readNullableString(source.attendeeNamesRaw),
    statusRaw: readNullableString(source.statusRaw),
    notes: readNullableString(source.notes),
    pointPersonName: readNullableString(source.pointPersonName),
    pointPersonUserId: readNullableString(source.pointPersonUserId),
    sourceImportBatchId: readString(source.sourceImportBatchId) ?? readString(source.importBatchId),
    contactId: readString(source.contactId),
    contact: readContactInput(source),
  };
}

function readContactPayload(body: unknown) {
  const source = isRecord(body) ? body : {};
  return {
    contact: readContactInput(source),
    sourceImportBatchId: readString(source.sourceImportBatchId) ?? readString(source.importBatchId),
  };
}

function handleError(res: express.Response, error: unknown) {
  if (error instanceof EventureServiceError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }

  const message = error instanceof Error ? error.message : "Unknown server error";
  res.status(500).json({ error: message });
}

router.use(requireAuth);

router.get("/", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const items = await listSponsorsForEvent(user!.organizationId, eventId);
    res.json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/dashboard", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const item = await getSponsorDashboardForEvent(user!.organizationId, eventId);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/follow-ups", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const items = await listSponsorFollowUpsForEvent(user!.organizationId, eventId);
    res.json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/with-contact", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const result = await saveSponsorWithContactForEvent(user!.organizationId, eventId, readSponsorPayload(req.body));
    res.status(201).json({ item: result.eventSponsor, sponsorOrganization: result.sponsorOrganization, contact: result.contact });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/:sponsorId/archive", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const sponsorId = readRouteParam(req.params["sponsorId"], "sponsorId");
    const item = await archiveSponsorForEvent(user!.organizationId, eventId, sponsorId);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.delete("/:sponsorId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const sponsorId = readRouteParam(req.params["sponsorId"], "sponsorId");
    const item = await removeSponsorForEvent(user!.organizationId, eventId, sponsorId);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/:sponsorId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const sponsorId = readRouteParam(req.params["sponsorId"], "sponsorId");
    const item = await getSponsorForEvent(user!.organizationId, eventId, sponsorId);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/:sponsorId/contacts", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const sponsorId = readRouteParam(req.params["sponsorId"], "sponsorId");
    const item = await createSponsorContactForEvent(user!.organizationId, eventId, sponsorId, readContactPayload(req.body));
    res.status(201).json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch("/:sponsorId/contacts/:contactId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const sponsorId = readRouteParam(req.params["sponsorId"], "sponsorId");
    const contactId = readRouteParam(req.params["contactId"], "contactId");
    const item = await updateSponsorContactForEvent(user!.organizationId, eventId, sponsorId, contactId, readContactPayload(req.body));
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/:sponsorId/contacts/:contactId/archive", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const sponsorId = readRouteParam(req.params["sponsorId"], "sponsorId");
    const contactId = readRouteParam(req.params["contactId"], "contactId");
    const item = await archiveSponsorContactForEvent(user!.organizationId, eventId, sponsorId, contactId);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.delete("/:sponsorId/contacts/:contactId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const sponsorId = readRouteParam(req.params["sponsorId"], "sponsorId");
    const contactId = readRouteParam(req.params["contactId"], "contactId");
    const item = await removeSponsorContactForEvent(user!.organizationId, eventId, sponsorId, contactId);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch("/:sponsorId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const sponsorId = readRouteParam(req.params["sponsorId"], "sponsorId");
    const item = await updateSponsorForEvent(user!.organizationId, eventId, sponsorId, readSponsorPayload(req.body));
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const item = await createSponsorForEvent(user!.organizationId, eventId, readSponsorPayload(req.body));
    res.status(201).json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

export { router as eventureSponsorsRouter };
