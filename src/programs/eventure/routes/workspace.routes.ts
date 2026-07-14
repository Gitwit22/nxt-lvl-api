import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import {
  cleanupUnconfirmedParticipants,
  confirmPaymentAndSyncParticipant,
  createParticipantForEvent,
  createStandalonePaymentTransaction,
  createAssignmentForEvent,
  listAttendeesForEvent,
  listAssignmentsForEvent,
  listParticipantsForEvent,
  listPaymentsForEvent,
  listVolunteersForEvent,
  mergeParticipantIntoCompany,
  removeParticipantFromEvent,
  updateAttendeeSlot,
  updateParticipantAttendeeCount,
  updateParticipantFlightAssignment,
  attachPriceOptionToParticipant,
  listParticipantPackages,
  removeParticipantPackage,
} from "../services/workspace.service.js";
import {
  assignAttendeeToSlot,
  unassignAttendeeFromSlot,
  bulkFillSlots,
  type BulkFillRow,
} from "../services/attendee-assignment.service.js";
import { EventureServiceError } from "../services/eventure-error.js";

const router = express.Router({ mergeParams: true });

function setShortLivedReadCache(res: express.Response) {
  res.setHeader("Cache-Control", "private, max-age=15, stale-while-revalidate=45");
}

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
  if (typeof value === "string") return value.trim();
  throw new EventureServiceError("Expected a string value.", 400);
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

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readLineItems(value: unknown) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new EventureServiceError("lineItems must be an array when provided.", 400);
  }

  return value.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new EventureServiceError(`lineItems[${index}] must be an object.`, 400);
    }

    const record = item as Record<string, unknown>;
    const category = readString(record["category"]);
    const amount = readNumber(record["amount"]);
    const description = readNullableString(record["description"]);

    if (!category) {
      throw new EventureServiceError(`lineItems[${index}].category is required.`, 400);
    }

    if (amount === undefined) {
      throw new EventureServiceError(`lineItems[${index}].amount is required.`, 400);
    }

    if (amount < 0) {
      throw new EventureServiceError(`lineItems[${index}].amount must be 0 or greater.`, 400);
    }

    return { category, amount, description };
  });
}

type PaymentFollowUpFieldKey =
  | "attendee_count"
  | "amount_due"
  | "amount_paid"
  | "payment_method"
  | "notes"
  | "additional_donation_amount"
  | "additional_donation_description";

const PAYMENT_FOLLOW_UP_FIELD_KEYS = new Set<PaymentFollowUpFieldKey>([
  "attendee_count",
  "amount_due",
  "amount_paid",
  "payment_method",
  "notes",
  "additional_donation_amount",
  "additional_donation_description",
]);

function readPaymentFieldFollowUps(value: unknown) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new EventureServiceError("paymentFieldFollowUps must be an array when provided.", 400);
  }

  return value.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new EventureServiceError(`paymentFieldFollowUps[${index}] must be an object.`, 400);
    }

    const record = item as Record<string, unknown>;
    const fieldKey = readString(record["fieldKey"]);
    const fieldLabel = readString(record["fieldLabel"]);
    const note = readNullableString(record["note"]);
    const checked = readBoolean(record["checked"]);

    if (!fieldKey || !PAYMENT_FOLLOW_UP_FIELD_KEYS.has(fieldKey as PaymentFollowUpFieldKey)) {
      throw new EventureServiceError(`paymentFieldFollowUps[${index}].fieldKey is invalid.`, 400);
    }

    return {
      fieldKey: fieldKey as PaymentFollowUpFieldKey,
      fieldLabel,
      note,
      checked: checked ?? true,
    };
  });
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

router.get("/payments", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const items = await listPaymentsForEvent(user!.organizationId, eventId);
    setShortLivedReadCache(res);
    res.json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/payments/confirm", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const contactCompanyId = readString(req.body?.contactCompanyId);
    const attendeeCount = readNumber(req.body?.attendeeCount) ?? 0;
    const priceOptionId = readString(req.body?.priceOptionId);

    if (!contactCompanyId) {
      throw new EventureServiceError("contactCompanyId is required.", 400);
    }

    // attendeeCount is only strictly required when no priceOptionId is given
    if (!priceOptionId && !Number.isInteger(attendeeCount)) {
      throw new EventureServiceError("attendeeCount must be an integer.", 400);
    }

    const item = await confirmPaymentAndSyncParticipant({
      organizationId: user!.organizationId,
      eventId,
      contactCompanyId,
      attendeeCount,
      priceOptionId,
      amountDue: readNumber(req.body?.amountDue),
      amountPaid: readNumber(req.body?.amountPaid),
      paymentMethod: readNullableString(req.body?.paymentMethod),
      notes: readNullableString(req.body?.notes),
      lineItems: readLineItems(req.body?.lineItems),
      paymentFieldFollowUps: readPaymentFieldFollowUps(req.body?.paymentFieldFollowUps),
      forceConfirmOverride: readBoolean(req.body?.forceConfirmOverride),
      overrideReason: readNullableString(req.body?.overrideReason),
      actorUserId: user!.userId,
      forceRemoveNamedSlots: readBoolean(req.body?.forceRemoveNamedSlots),
    });

    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/payments/transactions", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const contactCompanyId = readString(req.body?.contactCompanyId);
    const amountPaid = readNumber(req.body?.amountPaid);

    if (!contactCompanyId) {
      throw new EventureServiceError("contactCompanyId is required.", 400);
    }

    if (amountPaid === undefined) {
      throw new EventureServiceError("amountPaid is required.", 400);
    }

    const item = await createStandalonePaymentTransaction({
      organizationId: user!.organizationId,
      eventId,
      contactCompanyId,
      amountDue: readNumber(req.body?.amountDue),
      amountPaid,
      paymentMethod: readNullableString(req.body?.paymentMethod),
      notes: readNullableString(req.body?.notes),
      lineItems: readLineItems(req.body?.lineItems),
      paymentFieldFollowUps: readPaymentFieldFollowUps(req.body?.paymentFieldFollowUps),
      actorUserId: user!.userId,
    });

    res.status(201).json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/participants", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const items = await listParticipantsForEvent(user!.organizationId, eventId);
    setShortLivedReadCache(res);
    res.json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/participants", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const companyName = readString(req.body?.companyName);
    const participantName = readString(req.body?.participantName);
    const email = readString(req.body?.email);
    const phone = readString(req.body?.phone);
    const rawSlotCount = readNumber(req.body?.slotCount);
    const slotCount = rawSlotCount !== undefined && Number.isInteger(rawSlotCount) && rawSlotCount >= 0 ? rawSlotCount : 0;

    const item = await createParticipantForEvent({
      organizationId: user!.organizationId,
      eventId,
      createdByUserId: user!.userId,
      companyName,
      participantName,
      email,
      phone,
      slotCount,
    });

    res.status(201).json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/attendees", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const items = await listAttendeesForEvent(user!.organizationId, eventId);
    setShortLivedReadCache(res);
    res.json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch("/participants/:participantId/flight", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const participantId = readRouteParam(req.params["participantId"], "participantId");
    const flightAssignment = readString(req.body?.flightAssignment);

    if (!flightAssignment) {
      throw new EventureServiceError("flightAssignment is required.", 400);
    }

    const item = await updateParticipantFlightAssignment({
      organizationId: user!.organizationId,
      eventId,
      participantId,
      flightAssignment,
    });

    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch("/participants/:participantId/attendee-count", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const participantId = readRouteParam(req.params["participantId"], "participantId");
    const attendeeCount = readNumber(req.body?.attendeeCount);

    if (!Number.isInteger(attendeeCount)) {
      throw new EventureServiceError("attendeeCount must be an integer.", 400);
    }

    const item = await updateParticipantAttendeeCount({
      organizationId: user!.organizationId,
      eventId,
      participantId,
      attendeeCount,
      forceRemoveNamedSlots: readBoolean(req.body?.forceRemoveNamedSlots),
    });

    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.delete("/participants/:participantId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const participantId = readRouteParam(req.params["participantId"], "participantId");
    const deletePayments = req.query["deletePayments"] === "true";

    const item = await removeParticipantFromEvent({
      organizationId: user!.organizationId,
      eventId,
      participantId,
      deletePayments,
    });

    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/participants/:participantId/merge", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const participantId = readRouteParam(req.params["participantId"], "participantId");
    const targetCompanyId = readString(req.body?.targetCompanyId);

    if (!targetCompanyId) {
      throw new EventureServiceError("targetCompanyId is required.", 400);
    }

    const item = await mergeParticipantIntoCompany({
      organizationId: user!.organizationId,
      eventId,
      sourceParticipantId: participantId,
      targetCompanyId,
    });

    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch("/attendee-slots/:slotId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const slotId = readRouteParam(req.params["slotId"], "slotId");

    const item = await updateAttendeeSlot({
      organizationId: user!.organizationId,
      eventId,
      slotId,
      actualName: readNullableString(req.body?.actualName),
      notes: readNullableString(req.body?.notes),
      checkedIn: readBoolean(req.body?.checkedIn),
      mealPreference: readNullableString(req.body?.mealPreference),
      dietaryOverride: readNullableString(req.body?.dietaryOverride),
      tshirtSize: readNullableString(req.body?.tshirtSize),
      badgePrinted: readBoolean(req.body?.badgePrinted),
    });

    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/assignments", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const items = await listAssignmentsForEvent(user!.organizationId, eventId);
    setShortLivedReadCache(res);
    res.json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/assignments", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");

    const targetType = readString(req.body?.targetType) as "participant" | "attendee_slot" | "volunteer" | "staff" | undefined;
    if (!targetType) {
      throw new EventureServiceError("targetType is required.", 400);
    }

    const item = await createAssignmentForEvent({
      organizationId: user!.organizationId,
      eventId,
      assignmentType: readString(req.body?.assignmentType),
      targetType,
      participantId: readString(req.body?.participantId),
      attendeeSlotId: readString(req.body?.attendeeSlotId),
      volunteerNeedId: readString(req.body?.volunteerNeedId),
      staffMemberName: readString(req.body?.staffMemberName),
      title: readString(req.body?.title) ?? "",
      notes: readNullableString(req.body?.notes),
      actorUserId: user!.userId,
    });

    res.status(201).json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/volunteers", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const items = await listVolunteersForEvent(user!.organizationId, eventId);
    setShortLivedReadCache(res);
    res.json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * Admin-only: repair participants that have a confirmed payment but paymentConfirmed=false,
 * and soft-archive participants with no confirmed payment.
 * Supports ?dryRun=true to preview changes without writing.
 */
router.post("/cleanup-unconfirmed-participants", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const dryRun = req.query["dryRun"] === "true" || readBoolean(req.body?.dryRun) === true;
    const result = await cleanupUnconfirmedParticipants({
      organizationId: user!.organizationId,
      eventId,
      dryRun,
    });
    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

// ─── Participant Package endpoints ───────────────────────────────────────────

router.get("/participants/:participantId/packages", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const participantId = readRouteParam(req.params["participantId"], "participantId");
    const items = await listParticipantPackages({
      organizationId: user!.organizationId,
      eventId,
      participantId,
    });
    setShortLivedReadCache(res);
    res.json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/participants/:participantId/packages", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const participantId = readRouteParam(req.params["participantId"], "participantId");
    const priceOptionId = readString(req.body?.priceOptionId);

    if (!priceOptionId) {
      throw new EventureServiceError("priceOptionId is required.", 400);
    }

    const item = await attachPriceOptionToParticipant({
      organizationId: user!.organizationId,
      eventId,
      participantId,
      priceOptionId,
      quantity: readNumber(req.body?.quantity) ?? 1,
      unitPriceCentsOverride: readNumber(req.body?.unitPriceCentsOverride),
      flightOverride: readNullableString(req.body?.flightOverride),
      paymentStatus: readString(req.body?.paymentStatus),
      notes: readNullableString(req.body?.notes),
    });
    res.status(201).json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.delete("/participants/:participantId/packages/:packageId", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const participantId = readRouteParam(req.params["participantId"], "participantId");
    const packageId = readRouteParam(req.params["packageId"], "packageId");
    const result = await removeParticipantPackage({
      organizationId: user!.organizationId,
      eventId,
      participantId,
      packageId,
    });
    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

// ─── Attendee slot assignment endpoints ──────────────────────────────────────

router.put("/attendee-slots/:slotId/attendee", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const slotId = readRouteParam(req.params["slotId"], "slotId");
    const attendeeId = readString(req.body?.attendeeId);

    if (!attendeeId) {
      throw new EventureServiceError("attendeeId is required.", 400);
    }

    await assignAttendeeToSlot({
      slotId,
      attendeeId,
      eventId,
      organizationId: user!.organizationId,
      userId: user!.userId,
    });

    res.json({ success: true });
  } catch (error) {
    handleError(res, error);
  }
});

router.delete("/attendee-slots/:slotId/attendee", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const slotId = readRouteParam(req.params["slotId"], "slotId");

    await unassignAttendeeFromSlot({
      slotId,
      eventId,
      organizationId: user!.organizationId,
    });

    res.json({ success: true });
  } catch (error) {
    handleError(res, error);
  }
});

// ─── Bulk fill slots for a participant ───────────────────────────────────────

router.post("/participants/:participantId/bulk-fill", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const participantId = readRouteParam(req.params["participantId"], "participantId");
    const allowPartial = readBoolean(req.body?.allowPartial) ?? false;

    const rawRows = req.body?.rows;
    if (!Array.isArray(rawRows) || rawRows.length === 0) {
      throw new EventureServiceError("rows must be a non-empty array.", 400);
    }

    const rows: BulkFillRow[] = rawRows.map((row: unknown, index: number) => {
      if (!row || typeof row !== "object") {
        throw new EventureServiceError(`rows[${index}] must be an object.`, 400);
      }
      const r = row as Record<string, unknown>;
      const rowId = readString(r["rowId"]);
      if (!rowId) {
        throw new EventureServiceError(`rows[${index}].rowId is required.`, 400);
      }
      return {
        rowId,
        firstName: readNullableString(r["firstName"]),
        lastName: readNullableString(r["lastName"]),
        email: readNullableString(r["email"]),
        phone: readNullableString(r["phone"]),
        companyId: readNullableString(r["companyId"]),
        companyName: readNullableString(r["companyName"]),
        title: readNullableString(r["title"]),
      };
    });

    const results = await bulkFillSlots({
      participantId,
      rows,
      eventId,
      organizationId: user!.organizationId,
      userId: user!.userId,
      allowPartial,
    });

    res.json({ results });
  } catch (error) {
    handleError(res, error);
  }
});

export { router as eventureWorkspaceRouter };
