import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import { upload } from "../../../validators.js";
import {
  confirmSponsorImportForEvent,
  previewSponsorImportForEvent,
  type SponsorImportParserStrategy,
} from "../services/sponsor-import.service.js";
import { listImportBatchesForEvent } from "../repositories/sponsor-import.repository.js";
import { EventureServiceError } from "../services/eventure-error.js";

type SponsorImportMode = "existing_event" | "master_contacts_only" | "create_event";

const router = express.Router({ mergeParams: true });

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRouteParam(value: unknown, fieldName: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new EventureServiceError(`${fieldName} is required.`, 400);
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
  if (value === "existing_event" || value === "master_contacts_only" || value === "create_event") return value;
  throw new EventureServiceError("mode must be one of: existing_event, master_contacts_only, create_event.", 400);
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

router.get("/", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const items = await listImportBatchesForEvent(user!.organizationId, eventId);
    res.json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/preview", upload.single("file"), async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");

    const result = await previewSponsorImportForEvent({
      organizationId: user!.organizationId,
      eventId,
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
    const eventId = readRouteParam(req.params["eventId"], "eventId");

    const result = await confirmSponsorImportForEvent({
      organizationId: user!.organizationId,
      eventId,
      createdByUserId: user!.userId,
      importBatchId: readImportBatchId(req),
    });

    res.status(201).json(result);
  } catch (error) {
    handleError(res, error);
  }
});

export { router as eventureSponsorImportsRouter };
