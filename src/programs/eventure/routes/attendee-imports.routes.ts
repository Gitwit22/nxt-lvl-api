import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import { upload } from "../../../validators.js";
import {
  confirmAttendeeImportForEvent,
  listAttendeeImportBatchesForEvent,
  previewAttendeeImportForEvent,
  previewAttendeeImportRollback,
  rollbackAttendeeImportBatch,
  type AttendeeImportConfirmRowDecisionInput,
  type AttendeeImportRollbackMode,
} from "../services/attendee-import.service.js";
import { EventureServiceError } from "../services/eventure-error.js";

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

function readImportBatchIdParam(req: express.Request): string {
  return readRouteParam(req.params["importBatchId"], "importBatchId");
}

function readRollbackMode(value: unknown): AttendeeImportRollbackMode {
  if (value === "archive" || value === "hard_delete") return value;
  throw new EventureServiceError("mode must be one of: archive, hard_delete.", 400);
}

function readRollbackBody(req: express.Request): { mode: AttendeeImportRollbackMode; confirmationText: string } {
  const confirmationText = readString(req.body?.confirmationText);
  if (!confirmationText) {
    throw new EventureServiceError("confirmationText is required.", 400);
  }

  return {
    mode: readRollbackMode(req.body?.mode),
    confirmationText,
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
    const items = await listAttendeeImportBatchesForEvent(user!.organizationId, eventId);
    res.json({
      items: items.map((item) => ({
        ...item,
        importScope: "EVENT",
      })),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/preview", upload.single("file"), async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const payload = getImportPayload(req);

    const result = await previewAttendeeImportForEvent({
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

    const result = await confirmAttendeeImportForEvent({
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

router.get("/:importBatchId/rollback-preview", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const importBatchId = readImportBatchIdParam(req);

    const result = await previewAttendeeImportRollback({
      organizationId: user!.organizationId,
      eventId,
      importBatchId,
      role: user?.role,
      platformRole: user?.platformRole,
    });

    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/:importBatchId/rollback", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const importBatchId = readImportBatchIdParam(req);
    const body = readRollbackBody(req);

    const result = await rollbackAttendeeImportBatch({
      organizationId: user!.organizationId,
      eventId,
      importBatchId,
      mode: body.mode,
      confirmationText: body.confirmationText,
      actorRole: user?.role,
      actorPlatformRole: user?.platformRole,
    });

    res.status(200).json(result);
  } catch (error) {
    handleError(res, error);
  }
});

export { router as eventureAttendeeImportsRouter };
