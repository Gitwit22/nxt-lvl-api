import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import { upload } from "../../../validators.js";
import { prisma } from "../../../core/db/prisma.js";
import { EventureServiceError } from "../services/eventure-error.js";
import {
  normalizeCompanyName,
  parseMoney,
  inferPaymentStatus,
} from "../services/sponsor-import.service.js";

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

/** Very minimal CSV parser — handles quoted fields with embedded commas/newlines. */
function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    const next = normalized[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(cell);
        cell = "";
      } else if (ch === "\n") {
        row.push(cell);
        cell = "";
        rows.push(row);
        row = [];
      } else {
        cell += ch;
      }
    }
  }

  // Flush last cell / row
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);

  return rows;
}

function normalizeColName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

const COL_ALIASES: Record<string, string[]> = {
  company: ["company", "sponsor", "organization", "companyname", "sponsorcompany"],
  contactName: ["contactname", "contact", "name", "representative"],
  package: ["package", "sponsorshippackage", "level"],
  amountPaid: ["amountpaid", "paid", "payment"],
  paymentStatus: ["paymentstatus", "status"],
  paymentMethod: ["paymentmethod", "method"],
  invoiceNumber: ["invoice", "invoicenumber", "invoicenum", "invoiceno", "ref", "reference"],
  notes: ["notes", "note", "paymentnotes"],
};

function resolveColIndex(header: string[], key: string): number {
  const aliases = COL_ALIASES[key] ?? [];
  return header.findIndex((h) => aliases.includes(normalizeColName(h)));
}

router.use(requireAuth);

/**
 * POST /events/:eventId/sponsors/payment-import
 * Accepts a CSV file (multipart/form-data field "file").
 * Matches rows to existing EventureEventSponsor records by normalized company name.
 * Patches only payment fields — contacts, logos, and org info are untouched.
 *
 * Returns: { updated: string[], notFound: string[], total: number }
 */
router.post("/", upload.single("file"), async (req, res) => {
  try {
    const user = getRequestUser(req);
    const eventId = readRouteParam(req.params["eventId"], "eventId");

    if (!req.file) {
      throw new EventureServiceError("No file uploaded.", 400);
    }

    const csvText = req.file.buffer.toString("utf-8");
    const rows = parseCsvText(csvText);

    if (rows.length < 2) {
      throw new EventureServiceError("CSV must have a header row and at least one data row.", 400);
    }

    const [headerRow, ...dataRows] = rows;

    const colCompany = resolveColIndex(headerRow, "company");
    if (colCompany === -1) {
      throw new EventureServiceError(
        'CSV must have a "Company" column. Accepted names: Company, Sponsor, Organization.',
        400,
      );
    }

    const colPackage = resolveColIndex(headerRow, "package");
    const colAmountPaid = resolveColIndex(headerRow, "amountPaid");
    const colPaymentStatus = resolveColIndex(headerRow, "paymentStatus");
    const colPaymentMethod = resolveColIndex(headerRow, "paymentMethod");
    const colInvoiceNumber = resolveColIndex(headerRow, "invoiceNumber");
    const colNotes = resolveColIndex(headerRow, "notes");

    // Load existing sponsors for this event
    const existingSponsors = await prisma.eventureEventSponsor.findMany({
      where: { organizationId: user!.organizationId, eventId },
      include: { sponsorOrganization: { select: { name: true } } },
    });

    // Build map: normalizedName → sponsor record
    const sponsorMap = new Map<string, (typeof existingSponsors)[0]>();
    for (const sponsor of existingSponsors) {
      const key = normalizeCompanyName(sponsor.sponsorOrganization.name);
      sponsorMap.set(key, sponsor);
    }

    const updated: string[] = [];
    const notFound: string[] = [];

    for (const row of dataRows) {
      const rawCompany = (row[colCompany] ?? "").trim();
      if (!rawCompany) continue;

      const normalizedName = normalizeCompanyName(rawCompany);
      const existing = sponsorMap.get(normalizedName);

      if (!existing) {
        notFound.push(rawCompany);
        continue;
      }

      // Build update data — only include fields present in CSV (non-empty)
      const data: Record<string, unknown> = {};

      const rawAmountPaid = colAmountPaid >= 0 ? (row[colAmountPaid] ?? "").trim() : "";
      const parsedAmount = parseMoney(rawAmountPaid);
      if (parsedAmount !== undefined) data.amountPaid = parsedAmount;

      const rawStatus = colPaymentStatus >= 0 ? (row[colPaymentStatus] ?? "").trim() : "";
      if (rawStatus) {
        data.paymentStatus = inferPaymentStatus({ statusRaw: rawStatus });
      }

      const rawMethod = colPaymentMethod >= 0 ? (row[colPaymentMethod] ?? "").trim() : "";
      if (rawMethod) data.paymentMethod = rawMethod;

      const rawInvoice = colInvoiceNumber >= 0 ? (row[colInvoiceNumber] ?? "").trim() : "";
      if (rawInvoice) data.paymentReference = rawInvoice;

      const rawNotes = colNotes >= 0 ? (row[colNotes] ?? "").trim() : "";
      if (rawNotes) data.paymentNotes = rawNotes;

      const rawPackage = colPackage >= 0 ? (row[colPackage] ?? "").trim() : "";
      if (rawPackage) data.sponsorshipPackage = rawPackage;

      if (Object.keys(data).length === 0) {
        // Row has a company name but no payment data — still counts as "found"
        updated.push(rawCompany);
        continue;
      }

      await prisma.eventureEventSponsor.update({
        where: { id: existing.id },
        data,
      });

      updated.push(rawCompany);
    }

    res.json({ updated, notFound, total: updated.length + notFound.length });
  } catch (error) {
    handleError(res, error);
  }
});

export { router as eventurePaymentImportRouter };
