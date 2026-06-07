import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import { upload } from "../../../validators.js";
import { EventureServiceError } from "../services/eventure-error.js";
import {
  confirmPaymentImportForEvent,
  previewPaymentImportForEvent,
  type PaymentImportConfirmRowDecisionInput,
} from "../services/payment-import.service.js";

const router = express.Router({ mergeParams: true });

function readRouteParam(value: unknown, fieldName: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new EventureServiceError(`${fieldName} is required.`, 400);
}

function handleError(res: express.Response, error: unknown) {
  if (error instanceof EventureServiceError) {
    res.status(error.statusCode ?? 400).json({ error: error.message });
    return;
  }
  console.error("[payment-import]", error);
  res.status(500).json({ error: "Internal server error." });
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getImportPayload(req: express.Request): { csvContent?: string; fileBuffer?: Buffer; fileMimeType?: string } {
  if (req.file?.buffer) {
    return {
      fileBuffer: req.file.buffer,
      fileMimeType: req.file.mimetype,
    };
  }

  const csvText = readString(req.body?.csvText);
  if (csvText) {
    return {
      csvContent: csvText,
    };
  }

  throw new EventureServiceError("Provide a file upload (.csv, .xlsx, .pdf, .md) or csvText in the request body.", 400);
}

function getFileName(req: express.Request): string | undefined {
  if (req.file?.originalname) return req.file.originalname;
  return readString(req.body?.fileName);
}

function readRowDecisions(req: express.Request): PaymentImportConfirmRowDecisionInput[] | undefined {
  const rawValue = req.body?.rowDecisions;
  if (rawValue === undefined || rawValue === null || rawValue === "") return undefined;

  if (Array.isArray(rawValue)) {
    return rawValue as PaymentImportConfirmRowDecisionInput[];
  }

  if (typeof rawValue === "string") {
    try {
      const parsed = JSON.parse(rawValue) as unknown;
      if (!Array.isArray(parsed)) {
        throw new EventureServiceError("rowDecisions must be a JSON array.", 400);
      }
      return parsed as PaymentImportConfirmRowDecisionInput[];
    } catch (error) {
      if (error instanceof EventureServiceError) throw error;
      throw new EventureServiceError("rowDecisions must be valid JSON.", 400);
    }
  }

  throw new EventureServiceError("rowDecisions must be a JSON array.", 400);
}

function readImportBatchId(req: express.Request): string {
  return readRouteParam(req.body?.importBatchId, "importBatchId");
}

router.use(requireAuth);

router.post("/preview", upload.single("file"), async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const payload = getImportPayload(req);

    const result = await previewPaymentImportForEvent({
      organizationId: user!.organizationId,
      eventId,
      createdByUserId: user!.userId,
      csvContent: payload.csvContent,
      fileBuffer: payload.fileBuffer,
      fileMimeType: payload.fileMimeType,
      fileName: getFileName(req),
    });

    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/confirm", upload.single("file"), async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");

    const result = await confirmPaymentImportForEvent({
      organizationId: user!.organizationId,
      eventId,
      createdByUserId: user!.userId,
      importBatchId: readImportBatchId(req),
      rowDecisions: readRowDecisions(req),
    });

    res.status(201).json(result);
  } catch (error) {
    handleError(res, error);
  }
});

export { router as eventurePaymentImportRouter };
