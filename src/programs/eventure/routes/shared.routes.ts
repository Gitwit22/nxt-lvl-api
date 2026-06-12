import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import { EventureServiceError } from "../services/eventure-error.js";
import {
  listSharedCompanies,
  listSharedContacts,
  listSharedSponsors,
  serializeCsv,
} from "../services/shared-directory.service.js";

const router = express.Router();

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveOrgId(req: express.Request): string {
  const user = getRequestUser(req);
  const queryOrgId = readString(req.query["orgId"]);
  if (queryOrgId && queryOrgId !== user?.organizationId) {
    throw new EventureServiceError("orgId does not match authenticated organization.", 403);
  }
  if (!user?.organizationId) {
    throw new EventureServiceError("Organization context is required.", 400);
  }
  return queryOrgId ?? user.organizationId;
}

function wantsCsv(req: express.Request): boolean {
  const format = readString(req.query["format"]);
  if (format?.toLowerCase() === "csv") return true;
  const accept = req.headers.accept ?? "";
  return typeof accept === "string" && accept.includes("text/csv");
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

router.get("/sponsors", async (req, res) => {
  try {
    const organizationId = resolveOrgId(req);
    const eventId = readString(req.query["eventId"]);
    const includeHistory = readString(req.query["includeHistory"]) === "true";
    const status = readString(req.query["status"]);

    const items = await listSharedSponsors({
      organizationId,
      eventId,
      includeHistory,
      status: status === "archived" || status === "all" || status === "active" ? status : undefined,
    });

    if (wantsCsv(req)) {
      res.setHeader("content-type", "text/csv; charset=utf-8");
      res.setHeader("content-disposition", 'attachment; filename="eventure-shared-sponsors.csv"');
      res.send(serializeCsv(items));
      return;
    }

    res.json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/companies", async (req, res) => {
  try {
    const organizationId = resolveOrgId(req);
    const status = readString(req.query["status"]);
    const search = readString(req.query["search"]);
    const items = await listSharedCompanies({
      organizationId,
      status: status === "archived" || status === "all" || status === "active" ? status : undefined,
      search,
    });

    if (wantsCsv(req)) {
      res.setHeader("content-type", "text/csv; charset=utf-8");
      res.setHeader("content-disposition", 'attachment; filename="eventure-shared-companies.csv"');
      res.send(serializeCsv(items));
      return;
    }

    res.json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/contacts", async (req, res) => {
  try {
    const organizationId = resolveOrgId(req);
    const status = readString(req.query["status"]);
    const items = await listSharedContacts({
      organizationId,
      status: status === "archived" || status === "all" || status === "active" ? status : undefined,
    });

    if (wantsCsv(req)) {
      res.setHeader("content-type", "text/csv; charset=utf-8");
      res.setHeader("content-disposition", 'attachment; filename="eventure-shared-contacts.csv"');
      res.send(serializeCsv(items));
      return;
    }

    res.json({ items });
  } catch (error) {
    handleError(res, error);
  }
});

export { router as eventureSharedRouter };
