import express from "express";
import JSZip from "jszip";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import { EventureServiceError } from "../services/eventure-error.js";
import { EventReportingService, type EventReportFilters } from "../services/event-reporting.service.js";
import { prisma } from "../../../core/db/prisma.js";
import { isR2Configured, downloadFromR2 } from "../../../core/storage/r2.js";

const router = express.Router({ mergeParams: true });

function setShortLivedReadCache(res: express.Response) {
  res.setHeader("Cache-Control", "private, max-age=15, stale-while-revalidate=45");
}

function readRouteParam(value: unknown, fieldName: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new EventureServiceError(`${fieldName} is required.`, 400);
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

function readStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0);
    return items.length > 0 ? items : undefined;
  }

  if (typeof value === "string" && value.trim()) {
    const items = value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return items.length > 0 ? items : undefined;
  }

  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readFilters(raw: Record<string, unknown>): EventReportFilters {
  const flightRaw = readString(raw["flight"]);
  const normalizedFlight = flightRaw?.toUpperCase();
  const flight = normalizedFlight === "AM" || normalizedFlight === "PM" || normalizedFlight === "UNASSIGNED"
    ? normalizedFlight
    : undefined;

  return {
    paymentStatus: readStringArray(raw["paymentStatus"]),
    packageIds: readStringArray(raw["packageIds"]),
    companyIds: readStringArray(raw["companyIds"]),
    participantStatus: readStringArray(raw["participantStatus"]),
    source: readStringArray(raw["source"]),
    dateFrom: readString(raw["dateFrom"]),
    dateTo: readString(raw["dateTo"]),
    includeArchived: readBoolean(raw["includeArchived"]),
    flight,
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

router.get("/summary", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const item = await EventReportingService.getSummary(
      user!.organizationId,
      eventId,
      readFilters(req.query as Record<string, unknown>),
    );
    setShortLivedReadCache(res);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/financial", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const item = await EventReportingService.getFinancial(
      user!.organizationId,
      eventId,
      readFilters(req.query as Record<string, unknown>),
    );
    setShortLivedReadCache(res);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/financial/reconciliation", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const item = await EventReportingService.getFinancialReconciliation(
      user!.organizationId,
      eventId,
      readFilters(req.query as Record<string, unknown>),
    );
    setShortLivedReadCache(res);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/financial/aging", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const item = await EventReportingService.getFinancialAging(
      user!.organizationId,
      eventId,
      readFilters(req.query as Record<string, unknown>),
    );
    setShortLivedReadCache(res);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/packages", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const item = await EventReportingService.getPackages(
      user!.organizationId,
      eventId,
      readFilters(req.query as Record<string, unknown>),
    );
    setShortLivedReadCache(res);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/participants", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const item = await EventReportingService.getParticipants(
      user!.organizationId,
      eventId,
      readFilters(req.query as Record<string, unknown>),
    );
    setShortLivedReadCache(res);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/attendees", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const item = await EventReportingService.getAttendees(
      user!.organizationId,
      eventId,
      readFilters(req.query as Record<string, unknown>),
    );
    setShortLivedReadCache(res);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/flights", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const item = await EventReportingService.getFlights(
      user!.organizationId,
      eventId,
      readFilters(req.query as Record<string, unknown>),
    );
    setShortLivedReadCache(res);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/check-ins", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const item = await EventReportingService.getCheckIns(
      user!.organizationId,
      eventId,
      readFilters(req.query as Record<string, unknown>),
    );
    setShortLivedReadCache(res);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/follow-ups", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const item = await EventReportingService.getFollowUps(
      user!.organizationId,
      eventId,
      readFilters(req.query as Record<string, unknown>),
    );
    setShortLivedReadCache(res);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/data-quality", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const item = await EventReportingService.getDataQuality(
      user!.organizationId,
      eventId,
      readFilters(req.query as Record<string, unknown>),
    );
    setShortLivedReadCache(res);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

router.get("/export", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const item = await EventReportingService.getFinancial(
      user!.organizationId,
      eventId,
      readFilters(req.query as Record<string, unknown>),
    );
    setShortLivedReadCache(res);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

// ─── Company Logo ZIP Export ──────────────────────────────────────────────────

type LogoExportScope = "all" | "paid" | "am" | "pm";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "company";
}

function dedupeFilename(seen: Map<string, number>, base: string, ext: string): string {
  const key = `${base}${ext}`;
  if (!seen.has(key)) {
    seen.set(key, 1);
    return key;
  }
  const count = seen.get(key)! + 1;
  seen.set(key, count);
  return `${base}-${count}${ext}`;
}

function inferExt(url: string): string {
  const clean = url.split("?")[0].split("#")[0];
  const lastSegment = clean.split("/").pop() ?? "";
  const dot = lastSegment.lastIndexOf(".");
  if (dot === -1) return ".png";
  const ext = lastSegment.slice(dot).toLowerCase();
  const allowed = new Set([".png", ".jpg", ".jpeg", ".svg", ".webp", ".gif"]);
  return allowed.has(ext) ? ext : ".png";
}

router.get("/company-logos/export", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const rawScope = (req.query["scope"] as string | undefined)?.toLowerCase() ?? "all";
    const scope: LogoExportScope = ["all", "paid", "am", "pm"].includes(rawScope)
      ? (rawScope as LogoExportScope)
      : "all";

    // Build participant filter
    const participantWhere: Record<string, unknown> = {
      organizationId: user!.organizationId,
      eventId,
    };
    if (scope === "paid") participantWhere["paymentConfirmed"] = true;
    if (scope === "am") participantWhere["flightAssignment"] = "AM";
    if (scope === "pm") participantWhere["flightAssignment"] = "PM";

    const participants = await prisma.eventureParticipant.findMany({
      where: participantWhere,
      include: {
        contactCompany: {
          select: {
            id: true,
            name: true,
            logoUrl: true,
            logoKey: true,
          },
        },
      },
    });

    // De-duplicate by company id
    const seenCompany = new Set<string>();
    const companiesForExport: {
      id: string;
      name: string;
      logoUrl: string | null;
      logoKey: string | null;
      paymentConfirmed: boolean;
      flightAssignment: string;
    }[] = [];

    for (const p of participants) {
      if (!p.contactCompany || seenCompany.has(p.contactCompanyId)) continue;
      seenCompany.add(p.contactCompanyId);
      companiesForExport.push({
        id: p.contactCompanyId,
        name: p.contactCompany.name,
        logoUrl: p.contactCompany.logoUrl,
        logoKey: p.contactCompany.logoKey ?? null,
        paymentConfirmed: p.paymentConfirmed,
        flightAssignment: p.flightAssignment,
      });
    }

    const event = await prisma.eventureEvent.findFirst({
      where: { id: eventId, organizationId: user!.organizationId },
      select: { title: true },
    });

    const zip = new JSZip();
    const logosFolder = zip.folder("logos")!;
    const seenFilenames = new Map<string, number>();
    const exportedAt = new Date().toISOString();

    type ManifestRow = {
      companyName: string;
      paymentStatus: string;
      flight: string;
      exportedFilename: string;
      logoFormat: string;
      logoAvailable: string;
      notes: string;
    };
    const manifest: ManifestRow[] = [];

    let exportedCount = 0;
    let missingCount = 0;

    for (const company of companiesForExport) {
      const hasLogoSource = !!(company.logoKey || company.logoUrl);

      if (!hasLogoSource) {
        missingCount++;
        manifest.push({
          companyName: company.name,
          paymentStatus: company.paymentConfirmed ? "paid" : "pending",
          flight: company.flightAssignment || "unassigned",
          exportedFilename: "",
          logoFormat: "",
          logoAvailable: "false",
          notes: "No logo uploaded",
        });
        continue;
      }

      let buffer: Buffer | null = null;
      let ext = ".png";
      let errorNote = "";

      try {
        if (isR2Configured() && company.logoKey) {
          buffer = await downloadFromR2(company.logoKey);
          ext = inferExt(company.logoKey);
        } else if (company.logoUrl) {
          if (company.logoUrl.startsWith("data:")) {
            // base64 data URI (dev fallback)
            const match = company.logoUrl.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              const mime = match[1];
              ext = mime === "image/svg+xml" ? ".svg"
                : mime === "image/webp" ? ".webp"
                : mime === "image/jpeg" ? ".jpg"
                : mime === "image/png" ? ".png"
                : ".png";
              buffer = Buffer.from(match[2], "base64");
            }
          } else {
            const fetchRes = await fetch(company.logoUrl, { signal: AbortSignal.timeout(8000) });
            if (fetchRes.ok) {
              ext = inferExt(company.logoUrl);
              buffer = Buffer.from(await fetchRes.arrayBuffer());
            } else {
              errorNote = `HTTP ${fetchRes.status}`;
            }
          }
        }
      } catch (err) {
        errorNote = err instanceof Error ? err.message : "fetch failed";
      }

      if (buffer) {
        const filename = dedupeFilename(seenFilenames, slugify(company.name), ext);
        logosFolder.file(filename, buffer);
        exportedCount++;
        manifest.push({
          companyName: company.name,
          paymentStatus: company.paymentConfirmed ? "paid" : "pending",
          flight: company.flightAssignment || "unassigned",
          exportedFilename: `logos/${filename}`,
          logoFormat: ext.replace(".", ""),
          logoAvailable: "true",
          notes: "",
        });
      } else {
        missingCount++;
        manifest.push({
          companyName: company.name,
          paymentStatus: company.paymentConfirmed ? "paid" : "pending",
          flight: company.flightAssignment || "unassigned",
          exportedFilename: "",
          logoFormat: "",
          logoAvailable: "false",
          notes: errorNote || "Could not retrieve logo",
        });
      }
    }

    // manifest.csv
    const csvHeader = "companyName,paymentStatus,flight,exportedFilename,logoFormat,logoAvailable,notes";
    const csvRows = manifest.map((r) =>
      [
        `"${r.companyName.replace(/"/g, '""')}"`,
        r.paymentStatus,
        r.flight,
        r.exportedFilename,
        r.logoFormat,
        r.logoAvailable,
        `"${r.notes.replace(/"/g, '""')}"`,
      ].join(","),
    );
    zip.file("manifest.csv", [csvHeader, ...csvRows].join("\n"));

    // README.txt
    const readme = [
      `Event: ${event?.title ?? eventId}`,
      `Export Date: ${exportedAt}`,
      `Scope: ${scope}`,
      `Total Companies: ${companiesForExport.length}`,
      `Logos Exported: ${exportedCount}`,
      `Missing Logos: ${missingCount}`,
      "",
      "Structure:",
      "  logos/           — logo image files",
      "  manifest.csv     — per-company export record",
      "  README.txt       — this file",
    ].join("\n");
    zip.file("README.txt", readme);

    const eventSlug = slugify(event?.title ?? eventId);
    const filename = `${eventSlug}-company-logos.zip`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");

    zip.generateNodeStream({ type: "nodebuffer", streamFiles: true }).pipe(res);
  } catch (error) {
    handleError(res, error);
  }
});

// ─── Attendee CSV exports ─────────────────────────────────────────────────────

import { buildAttendeeExportRows, rowsToCSV, type AttendeeExportReportType } from "../services/attendee-export.service.js";

const ATTENDEE_EXPORT_TYPES: AttendeeExportReportType[] = [
  "attendee-contact-list",
  "flight-manifest",
  "check-in-report",
  "meal-dietary",
  "badge-print",
];

const EXPORT_FILENAMES: Record<AttendeeExportReportType, string> = {
  "attendee-contact-list": "attendee-contact-list.csv",
  "flight-manifest": "flight-manifest.csv",
  "check-in-report": "check-in-report.csv",
  "meal-dietary": "meal-dietary.csv",
  "badge-print": "badge-print.csv",
};

for (const reportType of ATTENDEE_EXPORT_TYPES) {
  router.get(`/export/${reportType}`, async (req, res) => {
    try {
      const user = getRequestUser(req);
      const eventId = readRouteParam(req.params["eventId"], "eventId");

      const { columns, rows } = await buildAttendeeExportRows(eventId, user!.organizationId, reportType);
      const csv = rowsToCSV(rows, columns);

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${EXPORT_FILENAMES[reportType]}"`);
      res.setHeader("Cache-Control", "no-store");
      res.send(csv);
    } catch (error) {
      handleError(res, error);
    }
  });
}

// ─── Activity Log ────────────────────────────────────────────────────────

import { listActivityLogForEvent, ACTION_LABELS } from "../services/activity-log.service.js";

router.get("/activity-log", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");
    const limit = Math.min(Number(req.query["limit"]) || 100, 500);
    const offset = Number(req.query["offset"]) || 0;

    const { entries, total } = await listActivityLogForEvent(
      user!.organizationId,
      eventId,
      { limit, offset },
    );

    const enriched = entries.map((e) => ({
      ...e,
      actionLabel: ACTION_LABELS[e.action] ?? e.action,
    }));

    res.json({ entries: enriched, total });
  } catch (error) {
    handleError(res, error);
  }
});

export { router as eventureReportsRouter };
