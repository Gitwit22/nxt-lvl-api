import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import {
  deleteRegistrationForOrganization,
  getRegistrationForOrganization,
  patchRegistrationForOrganization,
  updatePaymentStatusForRegistration,
} from "../services/registration.service.js";
import { EventureServiceError } from "../services/eventure-error.js";

const router = express.Router();

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readFloat(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readDate(value: unknown): Date | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
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

router.get("/:registrationId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const item = await getRegistrationForOrganization(user!.organizationId, req.params.registrationId);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch("/:registrationId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const item = await patchRegistrationForOrganization(user!.organizationId, req.params.registrationId, {
      registrationType: readString(req.body?.registrationType),
      registrationStatus: readString(req.body?.registrationStatus),
      paymentStatus: readString(req.body?.paymentStatus),
      ticketTypeId: req.body?.ticketTypeId === null ? null : readString(req.body?.ticketTypeId),
      groupId: req.body?.groupId === null ? null : readString(req.body?.groupId),
      householdId: req.body?.householdId === null ? null : readString(req.body?.householdId),
      amountExpected: readFloat(req.body?.amountExpected),
      amountPaid: readFloat(req.body?.amountPaid),
      paymentMethod: req.body?.paymentMethod === null ? null : readString(req.body?.paymentMethod),
      paymentReference: req.body?.paymentReference === null ? null : readString(req.body?.paymentReference),
      paymentNotes: req.body?.paymentNotes === null ? null : readString(req.body?.paymentNotes),
      paymentRecordedAt: req.body?.paymentRecordedAt === null ? null : readDate(req.body?.paymentRecordedAt),
      paymentRecordedByUserId: req.body?.paymentRecordedByUserId === null
        ? null
        : readString(req.body?.paymentRecordedByUserId),
      checkedIn: typeof req.body?.checkedIn === "boolean" ? req.body.checkedIn : undefined,
      checkedInAt: req.body?.checkedInAt === null ? null : readDate(req.body?.checkedInAt),
      checkedInByUserId: req.body?.checkedInByUserId === null ? null : readString(req.body?.checkedInByUserId),
      source: readString(req.body?.source),
      importBatchId: req.body?.importBatchId === null ? null : readString(req.body?.importBatchId),
      notes: req.body?.notes === null ? null : readString(req.body?.notes),
    });

    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.delete("/:registrationId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const item = await deleteRegistrationForOrganization(user!.organizationId, req.params.registrationId);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch("/:registrationId/payment-status", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const paymentStatus = readString(req.body?.paymentStatus) ?? "";
    const item = await updatePaymentStatusForRegistration({
      organizationId: user!.organizationId,
      registrationId: req.params.registrationId,
      paymentStatus,
      contactCompanyId: req.body?.contactCompanyId === null ? null : readString(req.body?.contactCompanyId),
      amountExpected: readFloat(req.body?.amountExpected),
      amountPaid: readFloat(req.body?.amountPaid),
      paymentMethod: req.body?.paymentMethod === null ? null : readString(req.body?.paymentMethod),
      paymentReference: req.body?.paymentReference === null ? null : readString(req.body?.paymentReference),
      paymentNotes: req.body?.paymentNotes === null ? null : readString(req.body?.paymentNotes),
      actorUserId: user!.userId,
    });

    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

export { router as eventureRegistrationsRouter };