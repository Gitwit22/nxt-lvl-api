import express from "express";
import path from "path";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import { upload } from "../../../validators.js";
import { isR2Configured, uploadToR2, deleteFromR2, getR2SignedDownloadUrl } from "../../../core/storage/r2.js";
import { prisma } from "../../../core/db/prisma.js";
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

const ALLOWED_LOGO_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"];

/**
 * Returns true when the value looks like an R2 object key rather than a full URL or data URI.
 */
function isStoredAsR2Key(value: string): boolean {
  return !value.startsWith("http://") && !value.startsWith("https://") && !value.startsWith("data:");
}

/**
 * If the stored logoUrl is a raw R2 key, generate a short-lived signed URL;
 * otherwise return the URL as-is.
 */
async function resolveLogoUrl(org: { logoUrl: string | null; logoKey: string | null }): Promise<string | null> {
  // When R2 is active, always generate a fresh signed URL from the raw key.
  // This is reliable even when R2_PUBLIC_URL is misconfigured or points to the app domain.
  if (isR2Configured() && org.logoKey) {
    return getR2SignedDownloadUrl(org.logoKey, { disposition: "inline", expiresIn: 3600 });
  }
  if (!org.logoUrl) return null;
  // Fallback: raw key stored as logoUrl (R2_PUBLIC_URL was not set when uploaded)
  if (isStoredAsR2Key(org.logoUrl) && isR2Configured()) {
    return getR2SignedDownloadUrl(org.logoUrl, { disposition: "inline", expiresIn: 3600 });
  }
  return org.logoUrl;
}

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
    const resolvedItems = await Promise.all(
      items.map(async (sponsor) => {
        const logoUrl = await resolveLogoUrl(sponsor.sponsorOrganization);
        return { ...sponsor, sponsorOrganization: { ...sponsor.sponsorOrganization, logoUrl } };
      }),
    );
    res.json({ items: resolvedItems });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/dashboard", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const item = await getSponsorDashboardForEvent(user!.organizationId, eventId);
    res.setHeader("Cache-Control", "no-store");
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
    const raw = await getSponsorForEvent(user!.organizationId, eventId, sponsorId);
    const logoUrl = await resolveLogoUrl(raw.sponsorOrganization);
    const item = { ...raw, sponsorOrganization: { ...raw.sponsorOrganization, logoUrl } };
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


router.post("/:sponsorId/logo", upload.single("file"), async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const sponsorId = readRouteParam(req.params["sponsorId"], "sponsorId");

    if (!req.file) {
      res.status(400).json({ error: "No file uploaded." });
      return;
    }

    if (!ALLOWED_LOGO_TYPES.includes(req.file.mimetype)) {
      res.status(400).json({ error: "File type not allowed. Use JPEG, PNG, GIF, WebP, or SVG." });
      return;
    }

    const sponsor = await getSponsorForEvent(user!.organizationId, eventId, sponsorId);
    const org = sponsor.sponsorOrganization;

    const ext = path.extname(req.file.originalname).toLowerCase() || ".bin";
    const key = `eventure/${user!.organizationId}/sponsors/${org.id}/logo-${Date.now()}${ext}`;

    let logoUrl: string;
    let logoKey: string;

    if (isR2Configured()) {
      // Delete old logo if one exists
      if (org.logoKey) {
        await deleteFromR2(org.logoKey).catch(() => void 0);
      }
      const result = await uploadToR2(key, req.file.buffer, req.file.mimetype);
      logoKey = result.key;
      // Store the raw key as logoUrl so resolveLogoUrl always has the key available.
      // Using the key (not a potentially wrong public URL) ensures signed URLs always work.
      logoUrl = result.key;
    } else {
      // Local fallback: store buffer as base64 data URL (dev only)
      logoUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
      logoKey = key;
    }

    await prisma.eventureSponsorOrganization.update({
      where: { id: org.id },
      data: { logoUrl, logoKey },
    });

    // For the immediate UI response, always return a signed URL so the browser can display it.
    const responseLogoUrl = isR2Configured() && logoKey
      ? await getR2SignedDownloadUrl(logoKey, { disposition: "inline", expiresIn: 3600 })
      : logoUrl;

    res.json({ logoUrl: responseLogoUrl });
  } catch (error) {
    handleError(res, error);
  }
});

export { router as eventureSponsorsRouter };
