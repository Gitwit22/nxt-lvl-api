import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import { upload } from "../../../validators.js";
import {
  confirmParticipantRevenueImportForEvent,
  previewParticipantRevenueImportForEvent,
} from "../services/participant-revenue-import.service.js";
import { EventureServiceError } from "../services/eventure-error.js";
import type { AttendeeImportConfirmRowDecisionInput } from "../services/attendee-import.service.js";

const router = express.Router({ mergeParams: true });

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRouteParam(value: unknown, fieldName: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new EventureServiceError(`${fieldName} is required.`, 400);
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

  throw new EventureServiceError("Provide a file upload (.csv or .xlsx) or csvText in the request body.", 400);
}

function getFileName(req: express.Request): string | undefined {
  if (req.file?.originalname) return req.file.originalname;
  return readString(req.body?.fileName);
}

function readRowDecisions(req: express.Request): AttendeeImportConfirmRowDecisionInput[] | undefined {
  const rawValue = req.body?.rowDecisions;
  if (rawValue === undefined || rawValue === null || rawValue === "") return undefined;

  if (Array.isArray(rawValue)) {
    return rawValue as AttendeeImportConfirmRowDecisionInput[];
  }

  if (typeof rawValue === "string") {
    try {
      const parsed = JSON.parse(rawValue) as unknown;
      if (!Array.isArray(parsed)) {
        throw new EventureServiceError("rowDecisions must be a JSON array.", 400);
      }
      return parsed as AttendeeImportConfirmRowDecisionInput[];
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

function handleError(res: express.Response, error: unknown) {
  if (error instanceof EventureServiceError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }

  const message = error instanceof Error ? error.message : "Unknown server error";
  res.status(500).json({ error: message });
}

router.use(requireAuth);

router.post("/preview", upload.single("file"), async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const payload = getImportPayload(req);

    const result = await previewParticipantRevenueImportForEvent({
      organizationId: user!.organizationId,
      eventId,
      createdByUserId: user!.userId,
      csvContent: payload.csvContent,
      fileBuffer: payload.fileBuffer,
      fileMimeType: payload.fileMimeType,
      fileName: getFileName(req),
      parserStrategy: "native",
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

    const result = await confirmParticipantRevenueImportForEvent({
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

export { router as eventureParticipantRevenueImportsRouter };