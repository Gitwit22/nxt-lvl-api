import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import { upload } from "../../../validators.js";
import {
  type ConfirmCreateEventInput,
  confirmSponsorImportForEvent,
  type ConfirmRowDecisionInput,
  previewSponsorImportForEvent,
  type SponsorImportParserStrategy,
} from "../services/sponsor-import.service.js";
import { listImportBatchesForOrg } from "../repositories/sponsor-import.repository.js";
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

function getCsvContent(req: express.Request): string {
  if (req.file?.buffer) {
    return req.file.buffer.toString("utf8");
  }
  const csvText = readString(req.body?.csvText);
  if (csvText) return csvText;
  throw new EventureServiceError("Provide a CSV file upload or csvText in the request body.", 400);
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

function readImportBatchId(req: express.Request): string {
  const value = readString(req.body?.importBatchId);
  if (!value) throw new EventureServiceError("importBatchId is required.", 400);
  return value;
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
    const items = await listImportBatchesForOrg(user!.organizationId);
    res.json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/preview", upload.single("file"), async (req, res) => {
  try {
    const user = getRequestUser(req);

    const result = await previewSponsorImportForEvent({
      organizationId: user!.organizationId,
      createdByUserId: user!.userId,
      csvContent: getCsvContent(req),
      fileName: getFileName(req),
      parserStrategy: getParserStrategy(req),
      mode: getImportMode(req),
    });

    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/confirm", upload.single("file"), async (req, res) => {
  try {
    const user = getRequestUser(req);

    const result = await confirmSponsorImportForEvent({
      organizationId: user!.organizationId,
      createdByUserId: user!.userId,
      importBatchId: readImportBatchId(req),
      rowDecisions: readRowDecisions(req),
      createEvent: readCreateEvent(req),
    });

    res.status(201).json(result);
  } catch (error) {
    handleError(res, error);
  }
});

export { router as eventureSponsorImportsOrgRouter };
