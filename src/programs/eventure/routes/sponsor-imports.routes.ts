import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import { upload } from "../../../validators.js";
import {
  type ConfirmCreateEventInput,
  confirmSponsorImportForEvent,
  type ConfirmRowDecisionInput,
  type ImportSelectedTabsInput,
  previewSponsorImportRollback,
  previewSponsorImportForEvent,
  rollbackSponsorImportBatch,
  type SponsorImportRollbackMode,
  type SponsorImportParserStrategy,
} from "../services/sponsor-import.service.js";
import {
  confirmLogoImportForEvent,
  type LogoImportDecisionInput,
  previewLogoImportForEvent,
} from "../services/logo-import.service.js";
import { listImportBatchesForEvent } from "../repositories/sponsor-import.repository.js";
import { EventureServiceError } from "../services/eventure-error.js";

type SponsorImportMode =
  | "master_list_only"
  | "master_list_with_event_assignment"
  | "create_event_then_assign"
  | "existing_event"
  | "master_contacts_only"
  | "create_event";

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

function getParserStrategy(req: express.Request): SponsorImportParserStrategy | undefined {
  const value = readString(req.body?.parserStrategy);
  if (!value) return undefined;
  if (value === "native" || value === "llama_core") return value;
  throw new EventureServiceError("parserStrategy must be one of: native, llama_core.", 400);
}

function getImportMode(req: express.Request): SponsorImportMode | undefined {
  const value = readString(req.body?.mode);
  if (!value) return undefined;
  if (
    value === "master_list_only" ||
    value === "master_list_with_event_assignment" ||
    value === "create_event_then_assign" ||
    value === "existing_event" ||
    value === "master_contacts_only" ||
    value === "create_event"
  ) {
    return value;
  }

  throw new EventureServiceError(
    "mode must be one of: master_list_only, master_list_with_event_assignment, create_event_then_assign.",
    400,
  );
}

function readRowDecisions(req: express.Request): ConfirmRowDecisionInput[] | undefined {
  const rawValue = req.body?.rowDecisions;
  if (rawValue === undefined || rawValue === null || rawValue === "") return undefined;

  if (Array.isArray(rawValue)) {
    return rawValue as ConfirmRowDecisionInput[];
  }

  if (typeof rawValue === "string") {
    try {
      const parsed = JSON.parse(rawValue) as unknown;
      if (!Array.isArray(parsed)) {
        throw new EventureServiceError("rowDecisions must be a JSON array.", 400);
      }
      return parsed as ConfirmRowDecisionInput[];
    } catch (error) {
      if (error instanceof EventureServiceError) throw error;
      throw new EventureServiceError("rowDecisions must be valid JSON.", 400);
    }
  }

  throw new EventureServiceError("rowDecisions must be a JSON array.", 400);
}

function readLogoImportDecisions(req: express.Request): LogoImportDecisionInput[] | undefined {
  const rawValue = req.body?.decisions;
  if (rawValue === undefined || rawValue === null || rawValue === "") return undefined;

  if (Array.isArray(rawValue)) {
    return rawValue as LogoImportDecisionInput[];
  }

  if (typeof rawValue === "string") {
    try {
      const parsed = JSON.parse(rawValue) as unknown;
      if (!Array.isArray(parsed)) {
        throw new EventureServiceError("decisions must be a JSON array.", 400);
      }
      return parsed as LogoImportDecisionInput[];
    } catch (error) {
      if (error instanceof EventureServiceError) throw error;
      throw new EventureServiceError("decisions must be valid JSON.", 400);
    }
  }

  throw new EventureServiceError("decisions must be a JSON array.", 400);
}

function readCreateEvent(req: express.Request): ConfirmCreateEventInput | undefined {
  const rawValue = req.body?.createEvent;
  if (rawValue === undefined || rawValue === null || rawValue === "") return undefined;

  if (typeof rawValue === "string") {
    try {
      const parsed = JSON.parse(rawValue) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new EventureServiceError("createEvent must be a JSON object.", 400);
      }
      return parsed as ConfirmCreateEventInput;
    } catch (error) {
      if (error instanceof EventureServiceError) throw error;
      throw new EventureServiceError("createEvent must be valid JSON.", 400);
    }
  }

  if (typeof rawValue === "object" && !Array.isArray(rawValue)) {
    return rawValue as ConfirmCreateEventInput;
  }

  throw new EventureServiceError("createEvent must be a JSON object.", 400);
}

function readSelectedTabs(req: express.Request): ImportSelectedTabsInput | undefined {
  const rawValue = req.body?.selectedTabs;
  if (rawValue === undefined || rawValue === null || rawValue === "") return undefined;

  if (typeof rawValue === "string") {
    try {
      const parsed = JSON.parse(rawValue) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new EventureServiceError("selectedTabs must be a JSON object.", 400);
      }
      return parsed as ImportSelectedTabsInput;
    } catch (error) {
      if (error instanceof EventureServiceError) throw error;
      throw new EventureServiceError("selectedTabs must be valid JSON.", 400);
    }
  }

  if (typeof rawValue === "object" && !Array.isArray(rawValue)) {
    return rawValue as ImportSelectedTabsInput;
  }

  throw new EventureServiceError("selectedTabs must be a JSON object.", 400);
}

function readImportBatchId(req: express.Request): string {
  return readRouteParam(req.body?.importBatchId, "importBatchId");
}

function readImportBatchIdParam(req: express.Request): string {
  return readRouteParam(req.params["importBatchId"], "importBatchId");
}

function readRollbackMode(value: unknown): SponsorImportRollbackMode {
  if (value === "archive" || value === "hard_delete") return value;
  throw new EventureServiceError("mode must be one of: archive, hard_delete.", 400);
}

function readRollbackBody(req: express.Request): { mode: SponsorImportRollbackMode; confirmationText: string } {
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
    const items = await listImportBatchesForEvent(user!.organizationId, eventId);
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
    const importPayload = getImportPayload(req);

    const result = await previewSponsorImportForEvent({
      organizationId: user!.organizationId,
      eventId,
      createdByUserId: user!.userId,
      csvContent: importPayload.csvContent,
      fileBuffer: importPayload.fileBuffer,
      fileMimeType: importPayload.fileMimeType,
      fileName: getFileName(req),
      parserStrategy: getParserStrategy(req),
      mode: getImportMode(req),
    });

    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/logos/preview", upload.array("files", 200), async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const files = Array.isArray(req.files) ? req.files : [];

    const result = await previewLogoImportForEvent({
      organizationId: user!.organizationId,
      eventId,
      files,
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

    const result = await confirmSponsorImportForEvent({
      organizationId: user!.organizationId,
      eventId,
      createdByUserId: user!.userId,
      importBatchId: readImportBatchId(req),
      rowDecisions: readRowDecisions(req),
      createEvent: readCreateEvent(req),
      selectedTabs: readSelectedTabs(req),
      representativesAsAttendees: req.body?.representativesAsAttendees === true || req.body?.representativesAsAttendees === "true",
    });

    res.status(201).json(result);
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/logos/confirm", upload.array("files", 200), async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const files = Array.isArray(req.files) ? req.files : [];

    const result = await confirmLogoImportForEvent({
      organizationId: user!.organizationId,
      eventId,
      actorUserId: user!.userId,
      files,
      decisions: readLogoImportDecisions(req),
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

    const result = await previewSponsorImportRollback({
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

    const result = await rollbackSponsorImportBatch({
      organizationId: user!.organizationId,
      eventId,
      importBatchId,
      mode: body.mode,
      confirmationText: body.confirmationText,
      actorUserId: user?.userId,
      actorRole: user?.role,
      actorPlatformRole: user?.platformRole,
    });

    res.status(200).json(result);
  } catch (error) {
    handleError(res, error);
  }
});

export { router as eventureSponsorImportsRouter };
