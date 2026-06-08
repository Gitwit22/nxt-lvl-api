import { prisma } from "../../../core/db/prisma.js";
import { Prisma } from "@prisma/client";
import { EventureServiceError } from "./eventure-error.js";
import {
  cleanPhone,
  normalizeEmail,
  normalizeName,
  parseCsvOrXlsx,
  type AttendeeImportRowStatus,
} from "./attendee-import-parser.js";
import { buildCompanyCandidates, matchAttendeeCompany } from "./attendee-company-matcher.js";
import { normalizeCompanyName } from "./sponsor-import.service.js";

export type AttendeeImportParserStrategy = "native";

// Paid statuses: only these values trigger Participant + AttendeeSlot creation.
// "confirmed" is intentionally excluded — it is used for RSVP confirmation, not financial confirmation.
const PAID_STATUSES = new Set(["paid", "comped", "payment confirmed"]);

export function isPaidStatus(value?: string | null): boolean {
  const normalized = value?.trim().toLowerCase();
  return !!normalized && PAID_STATUSES.has(normalized);
}

export type AttendeeImportRowDecision =
  | "approve"
  | "skip"
  | "assign_existing_company"
  | "create_new_company"
  | "leave_individual"
  | "ignore";

export type AttendeeImportMatchStatus = "Matched" | "Possible Match" | "Unmatched" | "New Company Suggested";

const WEAK_COMPANY_MATCH_STATUSES: AttendeeImportMatchStatus[] = [
  "Possible Match",
  "Unmatched",
  "New Company Suggested",
];

export type AttendeeImportPreviewRow = {
  importRowId: string;
  rowNumber: number;
  status: AttendeeImportRowStatus;
  decision: AttendeeImportRowDecision;
  raw: Record<string, unknown>;
  normalized: {
    attendeeName?: string;
    attendeeEmail?: string;
    attendeePhone?: string;
    ticketBuyer?: string;
    ticketBuyerEmail?: string;
    ticketType?: string;
    eventName?: string;
    orderDate?: string;
    checkedIn?: boolean;
    flight?: "AM" | "PM";
    amount?: number;
  };
  suggestedCompany?: {
    id?: string;
    name?: string;
    matchStatus: AttendeeImportMatchStatus;
    confidence: number;
    reason: string;
  };
  existingAttendee?: {
    id: string;
    fullName: string;
    email?: string;
    phone?: string;
    company?: string;
  };
  warnings: string[];
  errors: string[];
};

export type AttendeeImportPreviewResponse = {
  importBatchId: string;
  importType: "attendee_list";
  importScope: "EVENT";
  importFormat: "csv" | "xlsx";
  eventId: string;
  fileName?: string;
  status: "preview_ready" | "needs_review" | "failed";
  summary: {
    totalRows: number;
    validRows: number;
    warningRows: number;
    errorRows: number;
    duplicateRows: number;
    matchedRows: number;
    possibleMatchRows: number;
    unmatchedRows: number;
    newCompanySuggestedRows: number;
  };
  columnMapping: Array<{ sourceColumn: string; normalizedColumn: string; target: string; confidence: number }>;
  rows: AttendeeImportPreviewRow[];
};

export type AttendeeImportConfirmRowDecisionInput = {
  importRowId?: string;
  rowNumber?: number;
  decision: AttendeeImportRowDecision;
  finalCompanyId?: string;
  createCompanyName?: string;
  notes?: string;
};

export type AttendeeImportConfirmResponse = {
  importBatchId: string;
  eventId: string;
  status: "confirmed" | "confirmed_with_warnings";
  summary: {
    attendeesCreated: number;
    registrationsCreated: number;
    attendeeSlotsCreated: number;
    companiesCreated: number;
    skippedRows: number;
    ignoredRows: number;
    duplicatesPrevented: number;
    pendingParticipantRows: number;
    unpaidAttendeesSkipped: number;
    failedRows: number;
  };
};

export type AttendeeImportRollbackMode = "archive" | "hard_delete";

export type AttendeeImportRollbackPreviewResponse = {
  importBatchId: string;
  status: string;
  canRollback: boolean;
  warnings: string[];
  counts: {
    registrations: number;
    attendees: number;
    attendeeSlots: number;
  };
  recommendedMode: "archive";
};

export type AttendeeImportRollbackResponse = {
  importBatchId: string;
  status: "rolled_back";
  mode: AttendeeImportRollbackMode;
  warnings: string[];
  affectedCounts: AttendeeImportRollbackPreviewResponse["counts"];
};

function detectImportFormat(fileMimeType?: string, fileName?: string): "csv" | "xlsx" {
  if (fileMimeType?.includes("sheet") || (fileName ?? "").toLowerCase().endsWith(".xlsx")) return "xlsx";
  return "csv";
}

function decisionForRow(row: AttendeeImportPreviewRow): AttendeeImportRowDecision {
  if (row.status === "error") return "skip";
  if (row.status === "duplicate") return "skip";
  if (row.suggestedCompany?.matchStatus === "Matched") return "approve";
  if (row.suggestedCompany?.matchStatus === "Possible Match") return "assign_existing_company";
  if (row.suggestedCompany?.matchStatus === "New Company Suggested") return "create_new_company";
  return "leave_individual";
}

function rowStatusFromIssues(warnings: string[], errors: string[], duplicate: boolean): AttendeeImportRowStatus {
  if (duplicate) return "duplicate";
  if (errors.length > 0) return "error";
  if (warnings.length > 0) return "warning";
  return "valid";
}

function shouldTreatAsDuplicate(attendeeEmail?: string, ticketType?: string): string | null {
  if (!attendeeEmail || !ticketType) return null;
  return `${attendeeEmail.trim().toLowerCase()}::${ticketType.trim().toLowerCase()}`;
}

function normalizeImportRowDecision(raw?: AttendeeImportConfirmRowDecisionInput): AttendeeImportRowDecision {
  if (!raw) return "approve";
  return raw.decision;
}

function isWeakCompanyMatchStatus(status?: string): status is AttendeeImportMatchStatus {
  return WEAK_COMPANY_MATCH_STATUSES.includes(status as AttendeeImportMatchStatus);
}

function splitAttendeeName(attendeeName?: string): { firstName?: string; lastName?: string } {
  if (!attendeeName) return {};
  const parts = attendeeName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) {
    return { firstName: parts[0] };
  }

  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

async function findExistingAttendee(input: {
  organizationId: string;
  attendeeEmail?: string;
  attendeePhone?: string;
}) {
  if (input.attendeeEmail) {
    const existingByEmail = await prisma.eventureAttendee.findFirst({
      where: {
        organizationId: input.organizationId,
        email: {
          equals: input.attendeeEmail,
          mode: "insensitive",
        },
      },
    });

    if (existingByEmail) return existingByEmail;
  }

  if (input.attendeePhone) {
    const existingByPhone = await prisma.eventureAttendee.findFirst({
      where: {
        organizationId: input.organizationId,
        phone: input.attendeePhone,
      },
    });

    if (existingByPhone) return existingByPhone;
  }

  return null;
}

function serializeExistingAttendee(attendee: {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  company: string | null;
}) {
  return {
    id: attendee.id,
    fullName: attendee.fullName,
    email: attendee.email ?? undefined,
    phone: attendee.phone ?? undefined,
    company: attendee.company ?? undefined,
  };
}

async function upsertAttendeeFromImport(input: {
  organizationId: string;
  createdByUserId: string;
  attendeeName?: string;
  attendeeEmail?: string;
  attendeePhone?: string;
  company?: string;
  importBatchId: string;
  importRowId: string;
}) {
  const existing = await findExistingAttendee({
    organizationId: input.organizationId,
    attendeeEmail: input.attendeeEmail,
    attendeePhone: input.attendeePhone,
  });

  const nameParts = splitAttendeeName(input.attendeeName);
  const notes = `Imported from attendee batch ${input.importBatchId} row ${input.importRowId}`;

  if (existing) {
    const nextFullName = input.attendeeName?.trim() || existing.fullName;
    const nextCompany = input.company?.trim();

    const updateData: Prisma.EventureAttendeeUpdateInput = {
      fullName: nextFullName,
      firstName: nameParts.firstName ?? existing.firstName ?? undefined,
      lastName: nameParts.lastName ?? existing.lastName ?? undefined,
      email: input.attendeeEmail ?? existing.email ?? undefined,
      phone: input.attendeePhone ?? existing.phone ?? undefined,
      notes: existing.notes ? `${existing.notes}\n${notes}` : notes,
      source: "import",
    };

    if (nextCompany) {
      updateData.company = nextCompany;
    }

    const attendee = await prisma.eventureAttendee.update({
      where: { id: existing.id },
      data: updateData,
    });

    return { attendee, created: false };
  }

  const attendee = await prisma.eventureAttendee.create({
    data: {
      organizationId: input.organizationId,
      firstName: nameParts.firstName,
      lastName: nameParts.lastName,
      fullName: input.attendeeName || "Unknown attendee",
      email: input.attendeeEmail,
      phone: input.attendeePhone,
      company: input.company,
      source: "import",
      notes,
      createdByUserId: input.createdByUserId,
    },
  });

  return { attendee, created: true };
}

export async function previewAttendeeImportForEvent(input: {
  organizationId: string;
  eventId: string;
  createdByUserId: string;
  csvContent?: string;
  fileBuffer?: Buffer;
  fileMimeType?: string;
  fileName?: string;
  parserStrategy?: AttendeeImportParserStrategy;
}): Promise<AttendeeImportPreviewResponse> {
  const event = await prisma.eventureEvent.findFirst({
    where: {
      id: input.eventId,
      organizationId: input.organizationId,
      archivedAt: null,
    },
    select: { id: true },
  });

  if (!event) {
    throw new EventureServiceError("Event not found.", 404);
  }

  if (!input.csvContent && !input.fileBuffer) {
    throw new EventureServiceError("Provide a file upload (.csv or .xlsx) or csvText in the request body.", 400);
  }

  const parsed = parseCsvOrXlsx({
    csvContent: input.csvContent,
    fileBuffer: input.fileBuffer,
    fileMimeType: input.fileMimeType,
  });

  if (parsed.rows.length === 0) {
    throw new EventureServiceError("No data rows were found in the attendee import file.", 400);
  }

  const companies = await buildCompanyCandidates(input.organizationId);

  const duplicateKeys = new Set<string>();
  const previewRows = await Promise.all(parsed.rows.map(async (row) => {
    const match = matchAttendeeCompany({
      candidates: companies,
      ticketBuyer: row.ticketBuyer,
      ticketBuyerEmail: row.ticketBuyerEmail,
      attendeeEmail: row.attendeeEmail,
      ticketType: row.ticketType,
      eventName: row.eventName,
    });

    const duplicateKey = shouldTreatAsDuplicate(row.attendeeEmail, row.ticketType);
    const duplicate = duplicateKey ? duplicateKeys.has(duplicateKey) : false;
    if (duplicateKey && !duplicate) duplicateKeys.add(duplicateKey);

    const warnings = [...row.warnings];
    const errors = [...row.errors];
    if (match.matchStatus === "Possible Match") {
      warnings.push("Possible company match requires review before confirm.");
    }

    if (match.matchStatus === "Unmatched") {
      warnings.push("Company is unmatched. Choose mapping action in review.");
    }

    if (duplicate) {
      warnings.push("Duplicate attendee email + ticket type in current upload.");
    }

    // Existing attendee lookup is used to show the user what this import would update.
    // The confirm step already performs the write; this is purely a preview/diff aid.
    const existingAttendee = row.attendeeEmail || row.attendeePhone
      ? await findExistingAttendee({
          organizationId: input.organizationId,
          attendeeEmail: row.attendeeEmail,
          attendeePhone: row.attendeePhone,
        })
      : null;

    const status = rowStatusFromIssues(warnings, errors, duplicate);

    return {
      rowNumber: row.rowNumber,
      status,
      decision: "approve" as AttendeeImportRowDecision,
      raw: row.raw,
      normalized: {
        attendeeName: row.attendeeName,
        attendeeEmail: row.attendeeEmail,
        attendeePhone: row.attendeePhone,
        ticketBuyer: row.ticketBuyer,
        ticketBuyerEmail: row.ticketBuyerEmail,
        ticketType: row.ticketType,
        eventName: row.eventName,
        orderDate: row.orderDate,
        checkedIn: row.checkedIn,
        flight: row.flightAssignment,
        amount: row.amountPaid ?? row.amountExpected ?? undefined,
      },
      suggestedCompany: {
        id: match.suggestedCompanyId,
        name: match.suggestedCompanyName,
        matchStatus: match.matchStatus,
        confidence: match.confidence,
        reason: match.reason,
      },
      existingAttendee: existingAttendee ? serializeExistingAttendee(existingAttendee) : undefined,
      warnings,
      errors,
    };
  }));

  const importBatch = await prisma.eventureImportBatch.create({
    data: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      fileName: input.fileName ?? "attendee-import.csv",
      fileType: detectImportFormat(input.fileMimeType, input.fileName),
      fileUrl: "inline-upload",
      sourceType: "attendee_list",
      status: "previewing",
      totalRows: previewRows.length,
      parsedRows: previewRows.length,
      mappingConfig: {
        parser: input.parserStrategy ?? "native",
        importType: "attendee_list",
      },
      createdByUserId: input.createdByUserId,
    },
  });

  const createdRows = await Promise.all(previewRows.map((row) => prisma.eventureImportRow.create({
    data: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      importBatchId: importBatch.id,
      rowNumber: row.rowNumber,
      rawData: row.raw as Prisma.InputJsonValue,
      normalizedData: {
        ...row.normalized,
        suggestedCompany: row.suggestedCompany,
      } as Prisma.InputJsonValue,
      status: row.status,
      errorMessage: row.errors[0],
      detectedEmail: row.normalized.attendeeEmail,
      detectedPhone: row.normalized.attendeePhone,
      detectedRegistrationType: row.normalized.ticketType,
    },
    select: { id: true, rowNumber: true },
  })));

  const rowIdByNumber = new Map(createdRows.map((row) => [row.rowNumber, row.id]));
  const rowsWithIds: AttendeeImportPreviewRow[] = previewRows.map((row) => ({
    ...row,
    importRowId: rowIdByNumber.get(row.rowNumber) ?? "",
    decision: decisionForRow({
      ...row,
      importRowId: rowIdByNumber.get(row.rowNumber) ?? "",
    }),
  }));

  const summary = {
    totalRows: rowsWithIds.length,
    validRows: rowsWithIds.filter((row) => row.status === "valid").length,
    warningRows: rowsWithIds.filter((row) => row.status === "warning").length,
    errorRows: rowsWithIds.filter((row) => row.status === "error").length,
    duplicateRows: rowsWithIds.filter((row) => row.status === "duplicate").length,
    matchedRows: rowsWithIds.filter((row) => row.suggestedCompany?.matchStatus === "Matched").length,
    possibleMatchRows: rowsWithIds.filter((row) => row.suggestedCompany?.matchStatus === "Possible Match").length,
    unmatchedRows: rowsWithIds.filter((row) => row.suggestedCompany?.matchStatus === "Unmatched").length,
    newCompanySuggestedRows: rowsWithIds.filter((row) => row.suggestedCompany?.matchStatus === "New Company Suggested").length,
  };

  await prisma.eventureImportBatch.update({
    where: { id: importBatch.id },
    data: {
      validRows: summary.validRows,
      errorRows: summary.errorRows,
      duplicateRows: summary.duplicateRows,
      status: summary.errorRows > 0 || summary.warningRows > 0 ? "needs_review" : "preview_ready",
    },
  });

  return {
    importBatchId: importBatch.id,
    importType: "attendee_list",
    importScope: "EVENT",
    importFormat: detectImportFormat(input.fileMimeType, input.fileName),
    eventId: input.eventId,
    fileName: input.fileName,
    status: summary.errorRows > 0 || summary.warningRows > 0 ? "needs_review" : "preview_ready",
    summary,
    columnMapping: parsed.columnMapping,
    rows: rowsWithIds,
  };
}

function readNormalizedRow(row: { normalizedData: unknown }) {
  const normalized = (row.normalizedData ?? {}) as Record<string, unknown>;
  const suggestedCompany = ((normalized.suggestedCompany ?? {}) as Record<string, unknown>);

  return {
    attendeeName: normalizeName(typeof normalized.attendeeName === "string" ? normalized.attendeeName : undefined),
    attendeeEmail: normalizeEmail(typeof normalized.attendeeEmail === "string" ? normalized.attendeeEmail : undefined),
    attendeePhone: cleanPhone(typeof normalized.attendeePhone === "string" ? normalized.attendeePhone : undefined),
    ticketBuyer: normalizeName(typeof normalized.ticketBuyer === "string" ? normalized.ticketBuyer : undefined),
    ticketBuyerEmail: normalizeEmail(typeof normalized.ticketBuyerEmail === "string" ? normalized.ticketBuyerEmail : undefined),
    ticketType: normalizeName(typeof normalized.ticketType === "string" ? normalized.ticketType : undefined),
    eventName: normalizeName(typeof normalized.eventName === "string" ? normalized.eventName : undefined),
    checkedIn: Boolean(normalized.checkedIn),
    flight: (normalized.flight === "AM" ? "AM" : "PM") as "AM" | "PM",
    paymentStatus: normalizeName(typeof normalized.paymentStatus === "string" ? normalized.paymentStatus : undefined),
    amountExpected: typeof normalized.amountExpected === "number" && Number.isFinite(normalized.amountExpected) ? normalized.amountExpected : undefined,
    amountPaid: typeof normalized.amountPaid === "number" && Number.isFinite(normalized.amountPaid) ? normalized.amountPaid : undefined,
    paymentMethod: normalizeName(typeof normalized.paymentMethod === "string" ? normalized.paymentMethod : undefined),
    paymentReference: normalizeName(typeof normalized.paymentReference === "string" ? normalized.paymentReference : undefined),
    paymentNotes: normalizeName(typeof normalized.paymentNotes === "string" ? normalized.paymentNotes : undefined),
    suggestedCompanyId: typeof suggestedCompany.id === "string" ? suggestedCompany.id : undefined,
    suggestedCompanyName: typeof suggestedCompany.name === "string" ? suggestedCompany.name : undefined,
    suggestedMatchStatus: typeof suggestedCompany.matchStatus === "string" ? suggestedCompany.matchStatus : undefined,
  };
}

export async function confirmAttendeeImportForEvent(input: {
  organizationId: string;
  eventId: string;
  createdByUserId: string;
  importBatchId: string;
  rowDecisions?: AttendeeImportConfirmRowDecisionInput[];
}): Promise<AttendeeImportConfirmResponse> {
  const batch = await prisma.eventureImportBatch.findFirst({
    where: {
      id: input.importBatchId,
      organizationId: input.organizationId,
      eventId: input.eventId,
      sourceType: "attendee_list",
    },
    include: {
      rows: {
        orderBy: { rowNumber: "asc" },
      },
    },
  });

  if (!batch) {
    throw new EventureServiceError("Attendee import batch not found.", 404);
  }

  const decisionByRowId = new Map((input.rowDecisions ?? []).filter((item) => item.importRowId).map((item) => [item.importRowId as string, item]));
  const decisionByRowNumber = new Map((input.rowDecisions ?? []).filter((item) => item.rowNumber !== undefined).map((item) => [item.rowNumber as number, item]));

  const unresolvedWeakMatchRows: number[] = [];
  for (const row of batch.rows) {
    const normalized = readNormalizedRow(row);
    if (!isWeakCompanyMatchStatus(normalized.suggestedMatchStatus)) continue;

    const rowDecisionInput = decisionByRowId.get(row.id) ?? decisionByRowNumber.get(row.rowNumber);
    const decision = normalizeImportRowDecision(rowDecisionInput);

    if (decision === "approve") {
      unresolvedWeakMatchRows.push(row.rowNumber);
      continue;
    }

    if (decision === "assign_existing_company") {
      const resolvedCompanyId = rowDecisionInput?.finalCompanyId ?? normalized.suggestedCompanyId;
      if (!resolvedCompanyId) {
        unresolvedWeakMatchRows.push(row.rowNumber);
      }
    }
  }

  if (unresolvedWeakMatchRows.length > 0) {
    const rows = unresolvedWeakMatchRows.sort((a, b) => a - b).join(", ");
    throw new EventureServiceError(
      `Resolve weak company matches before confirm. Rows: ${rows}.`,
      400,
    );
  }

  let attendeesCreated = 0;
  let registrationsCreated = 0;
  let attendeeSlotsCreated = 0;
  let companiesCreated = 0;
  let skippedRows = 0;
  let ignoredRows = 0;
  let duplicatesPrevented = 0;
  let pendingParticipantRows = 0;
  let unpaidAttendeesSkipped = 0;
  let failedRows = 0;

  for (const row of batch.rows) {
    const normalized = readNormalizedRow(row);
    const rowDecisionInput = decisionByRowId.get(row.id) ?? decisionByRowNumber.get(row.rowNumber);
    const decision = normalizeImportRowDecision(rowDecisionInput);

    if (decision === "skip") {
      skippedRows += 1;
      await prisma.eventureImportRow.update({ where: { id: row.id }, data: { status: "skipped" } });
      continue;
    }

    if (decision === "ignore") {
      ignoredRows += 1;
      await prisma.eventureImportRow.update({ where: { id: row.id }, data: { status: "ignored" } });
      continue;
    }

    if (!normalized.attendeeEmail && !normalized.attendeePhone) {
      failedRows += 1;
      await prisma.eventureImportRow.update({ where: { id: row.id }, data: { status: "error", errorMessage: "Cannot create attendee without email or phone." } });
      continue;
    }

    try {
      let finalCompanyId = rowDecisionInput?.finalCompanyId;
      let finalCompanyName = normalized.suggestedCompanyName ?? normalized.ticketBuyer;

      if (!finalCompanyId && decision === "assign_existing_company") {
        finalCompanyId = normalized.suggestedCompanyId;
      }

      if (decision === "create_new_company") {
        const companyName = normalizeName(rowDecisionInput?.createCompanyName) ?? normalized.ticketBuyer;
        if (companyName) {
          const normalizedName = normalizeCompanyName(companyName);
          const existing = await prisma.eventureSponsorOrganization.findFirst({
            where: {
              organizationId: input.organizationId,
              normalizedName,
            },
            select: { id: true, name: true },
          });

          if (existing) {
            finalCompanyId = existing.id;
            finalCompanyName = existing.name;
          } else {
            const created = await prisma.eventureSponsorOrganization.create({
              data: {
                organizationId: input.organizationId,
                name: companyName,
                normalizedName,
                mainEmail: normalized.ticketBuyerEmail,
                notes: `Created from attendee import batch ${batch.id}`,
                importSource: "attendee_list",
                sourceImportBatchId: batch.id,
                sourceImportRowId: row.id,
              },
            });
            finalCompanyId = created.id;
            finalCompanyName = created.name;
            companiesCreated += 1;
          }
        }
      }

      const attendeeResult = await upsertAttendeeFromImport({
        organizationId: input.organizationId,
        createdByUserId: input.createdByUserId,
        attendeeName: normalized.attendeeName,
        attendeeEmail: normalized.attendeeEmail,
        attendeePhone: normalized.attendeePhone,
        company: decision === "leave_individual" ? undefined : finalCompanyName,
        importBatchId: batch.id,
        importRowId: row.id,
      });
      const attendee = attendeeResult.attendee;

      if (attendeeResult.created) {
        attendeesCreated += 1;
      }

      const ticketType = normalized.ticketType ?? "registered";
      const existingRegistration = await prisma.eventureRegistration.findFirst({
        where: {
          organizationId: input.organizationId,
          eventId: input.eventId,
          attendeeId: attendee.id,
          registrationType: ticketType,
        },
        select: { id: true, notes: true },
      });

      let registrationId: string;
      let registrationWasCreated = false;
      if (existingRegistration) {
        await prisma.eventureRegistration.update({
          where: { id: existingRegistration.id },
          data: {
            registrationStatus: normalized.checkedIn ? "attended" : "registered",
            paymentStatus: normalized.paymentStatus ?? undefined,
            amountExpected: normalized.amountExpected ?? undefined,
            amountPaid: normalized.amountPaid ?? undefined,
            paymentMethod: normalized.paymentMethod ?? undefined,
            paymentReference: normalized.paymentReference ?? undefined,
            paymentNotes: normalized.paymentNotes ?? undefined,
            checkedIn: normalized.checkedIn,
            checkedInAt: normalized.checkedIn ? new Date() : null,
            importBatchId: batch.id,
            notes: rowDecisionInput?.notes ?? existingRegistration.notes,
          },
        });
        registrationId = existingRegistration.id;
      } else {
        const registration = await prisma.eventureRegistration.create({
          data: {
            organizationId: input.organizationId,
            eventId: input.eventId,
            attendeeId: attendee.id,
            registrationType: ticketType,
            registrationStatus: normalized.checkedIn ? "attended" : "registered",
            paymentStatus: normalized.paymentStatus ?? "pending",
            amountExpected: normalized.amountExpected ?? 0,
            amountPaid: normalized.amountPaid ?? 0,
            paymentMethod: normalized.paymentMethod ?? null,
            paymentReference: normalized.paymentReference ?? null,
            paymentNotes: normalized.paymentNotes ?? null,
            checkedIn: normalized.checkedIn,
            checkedInAt: normalized.checkedIn ? new Date() : null,
            source: "import",
            importBatchId: batch.id,
            notes: rowDecisionInput?.notes,
            createdByUserId: input.createdByUserId,
          },
        });
        registrationId = registration.id;
        registrationWasCreated = true;
        registrationsCreated += 1;
      }

      if (finalCompanyId && decision !== "leave_individual") {
        // Business rule: only paid/comped attendees become Participants and get AttendeeSlots.
        // Registrations are always created above regardless of payment status.
        if (!isPaidStatus(normalized.paymentStatus)) {
          unpaidAttendeesSkipped += 1;
          // Still mark the row as imported/updated so it doesn't block the batch
          await prisma.eventureImportRow.update({
            where: { id: row.id },
            data: {
              status: existingRegistration || !registrationWasCreated ? "updated" : "imported",
              createdRegistrationId: registrationId,
              matchedAttendeeId: attendee.id,
              errorMessage: null,
            },
          });
          continue;
        }

        let participant = await prisma.eventureParticipant.findFirst({
          where: {
            organizationId: input.organizationId,
            eventId: input.eventId,
            contactCompanyId: finalCompanyId,
          },
          select: {
            id: true,
            companyName: true,
            attendeeCount: true,
          },
        });

        if (!participant) {
          const participantCompanyName = finalCompanyName ?? normalized.ticketBuyer ?? "Participant Company";
          participant = await prisma.eventureParticipant.create({
            data: {
              organizationId: input.organizationId,
              eventId: input.eventId,
              contactCompanyId: finalCompanyId,
              companyName: participantCompanyName,
              paymentConfirmed: false,
              attendeeCount: 0,
              flightAssignment: normalized.flight,
              status: "pending",
            },
            select: {
              id: true,
              companyName: true,
              attendeeCount: true,
            },
          });
        } else if (finalCompanyName && participant.companyName !== finalCompanyName) {
          participant = await prisma.eventureParticipant.update({
            where: { id: participant.id },
            data: {
              companyName: finalCompanyName,
              flightAssignment: normalized.flight,
            },
            select: {
              id: true,
              companyName: true,
              attendeeCount: true,
            },
          });
        }

        const existingSlot = await prisma.eventureAttendeeSlot.findFirst({
          where: {
            organizationId: input.organizationId,
            eventId: input.eventId,
            participantId: participant.id,
            OR: [
              { notes: { contains: registrationId } },
              ...(normalized.attendeeName ? [{ actualName: normalized.attendeeName }] : []),
            ],
          },
          orderBy: { slotNumber: "asc" },
        });

        if (existingSlot) {
          await prisma.eventureAttendeeSlot.update({
            where: { id: existingSlot.id },
            data: {
              companyName: participant.companyName,
              displayName: normalized.attendeeName ?? existingSlot.displayName,
              actualName: normalized.attendeeName ?? existingSlot.actualName,
              flightAssignment: normalized.flight,
              checkedIn: normalized.checkedIn,
              notes: `Registration ${registrationId} imported from batch ${batch.id}`,
            },
          });
        } else {
          const currentMaxSlot = await prisma.eventureAttendeeSlot.findFirst({
            where: {
              organizationId: input.organizationId,
              eventId: input.eventId,
              participantId: participant.id,
            },
            orderBy: { slotNumber: "desc" },
            select: { slotNumber: true },
          });

          const nextSlotNumber = (currentMaxSlot?.slotNumber ?? 0) + 1;
          await prisma.eventureAttendeeSlot.create({
            data: {
              organizationId: input.organizationId,
              eventId: input.eventId,
              participantId: participant.id,
              companyName: participant.companyName,
              slotNumber: nextSlotNumber,
              displayName: normalized.attendeeName ?? `Attendee ${nextSlotNumber}`,
              actualName: normalized.attendeeName,
              flightAssignment: normalized.flight,
              checkedIn: normalized.checkedIn,
              notes: `Registration ${registrationId} imported from batch ${batch.id}`,
            },
          });
          attendeeSlotsCreated += 1;

          await prisma.eventureParticipant.update({
            where: { id: participant.id },
            data: {
              attendeeCount: participant.attendeeCount + 1,
            },
          });
        }
      }

      await prisma.eventureImportRow.update({
        where: { id: row.id },
        data: {
          status: existingRegistration || !registrationWasCreated ? "updated" : "imported",
          createdRegistrationId: registrationId,
          matchedAttendeeId: attendee.id,
          errorMessage: null,
        },
      });
    } catch (error) {
      failedRows += 1;
      await prisma.eventureImportRow.update({
        where: { id: row.id },
        data: {
          status: "error",
          errorMessage: error instanceof Error ? error.message : "Failed to import attendee row.",
        },
      });
    }
  }

  const summary = {
    attendeesCreated,
    registrationsCreated,
    attendeeSlotsCreated,
    companiesCreated,
    skippedRows,
    ignoredRows,
    duplicatesPrevented,
    pendingParticipantRows,
    unpaidAttendeesSkipped,
    failedRows,
  };

  await prisma.eventureImportBatch.update({
    where: { id: batch.id },
    data: {
      status: failedRows > 0 ? "completed_with_warnings" : "completed",
      completedAt: new Date(),
      validRows: registrationsCreated,
      errorRows: failedRows,
      duplicateRows: duplicatesPrevented,
      rollbackSummary: summary,
    },
  });

  return {
    importBatchId: batch.id,
    eventId: input.eventId,
    status: failedRows > 0 || pendingParticipantRows > 0 ? "confirmed_with_warnings" : "confirmed",
    summary,
  };
}

export async function listAttendeeImportBatchesForEvent(organizationId: string, eventId: string) {
  return prisma.eventureImportBatch.findMany({
    where: {
      organizationId,
      eventId,
      sourceType: "attendee_list",
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      fileName: true,
      status: true,
      totalRows: true,
      parsedRows: true,
      validRows: true,
      errorRows: true,
      duplicateRows: true,
      createdAt: true,
      completedAt: true,
      rolledBackAt: true,
      rollbackMode: true,
    },
  });
}

function canHardDelete(role?: string, platformRole?: string): boolean {
  return role === "admin" || platformRole === "suite_admin" || platformRole === "dev";
}

export async function previewAttendeeImportRollback(input: {
  organizationId: string;
  eventId: string;
  importBatchId: string;
  role?: string;
  platformRole?: string;
}): Promise<AttendeeImportRollbackPreviewResponse> {
  const batch = await prisma.eventureImportBatch.findFirst({
    where: {
      id: input.importBatchId,
      organizationId: input.organizationId,
      eventId: input.eventId,
      sourceType: "attendee_list",
    },
    select: {
      id: true,
      status: true,
    },
  });

  if (!batch) {
    throw new EventureServiceError("Attendee import batch not found.", 404);
  }

  const registrations = await prisma.eventureRegistration.findMany({
    where: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      importBatchId: input.importBatchId,
    },
    select: {
      id: true,
      attendeeId: true,
    },
  });

  const attendeeIds = [...new Set(registrations.map((item) => item.attendeeId))];
  const attendeesWithOtherRegistrations = attendeeIds.length === 0
    ? []
    : await prisma.eventureRegistration.findMany({
      where: {
        organizationId: input.organizationId,
        attendeeId: {
          in: attendeeIds,
        },
        importBatchId: {
          not: input.importBatchId,
        },
      },
      select: {
        attendeeId: true,
      },
    });

  const attendeesSafeToDelete = attendeeIds.filter((id) => !attendeesWithOtherRegistrations.some((item) => item.attendeeId === id));

  const attendeeSlots = await prisma.eventureAttendeeSlot.findMany({
    where: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      notes: {
        contains: `batch ${input.importBatchId}`,
      },
    },
    select: { id: true },
  });

  const warnings: string[] = [];
  if (!canHardDelete(input.role, input.platformRole)) {
    warnings.push("Hard delete requires admin privileges.");
  }

  return {
    importBatchId: batch.id,
    status: batch.status,
    canRollback: batch.status !== "rolled_back",
    warnings,
    counts: {
      registrations: registrations.length,
      attendees: attendeesSafeToDelete.length,
      attendeeSlots: attendeeSlots.length,
    },
    recommendedMode: "archive",
  };
}

export async function rollbackAttendeeImportBatch(input: {
  organizationId: string;
  eventId: string;
  importBatchId: string;
  mode: AttendeeImportRollbackMode;
  confirmationText: string;
  actorRole?: string;
  actorPlatformRole?: string;
}): Promise<AttendeeImportRollbackResponse> {
  if (input.confirmationText !== "ROLLBACK IMPORT") {
    throw new EventureServiceError("confirmationText must equal ROLLBACK IMPORT.", 400);
  }

  if (input.mode === "hard_delete" && !canHardDelete(input.actorRole, input.actorPlatformRole)) {
    throw new EventureServiceError("Hard delete rollback is restricted to admins.", 403);
  }

  const preview = await previewAttendeeImportRollback({
    organizationId: input.organizationId,
    eventId: input.eventId,
    importBatchId: input.importBatchId,
    role: input.actorRole,
    platformRole: input.actorPlatformRole,
  });

  if (!preview.canRollback) {
    throw new EventureServiceError("Import batch cannot be rolled back in current state.", 400);
  }

  const registrations = await prisma.eventureRegistration.findMany({
    where: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      importBatchId: input.importBatchId,
    },
    select: {
      id: true,
      attendeeId: true,
    },
  });

  const attendeeIds = [...new Set(registrations.map((item) => item.attendeeId))];
  const attendeeSlots = await prisma.eventureAttendeeSlot.findMany({
    where: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      notes: {
        contains: `batch ${input.importBatchId}`,
      },
    },
    select: { id: true },
  });

  if (input.mode === "archive") {
    await prisma.eventureImportBatch.update({
      where: { id: input.importBatchId },
      data: {
        status: "rolled_back",
        rolledBackAt: new Date(),
        rollbackMode: "archive",
      },
    });

    await prisma.eventureImportRow.updateMany({
      where: { importBatchId: input.importBatchId },
      data: { rolledBackAt: new Date(), status: "rolled_back" },
    });

    await prisma.eventureRegistration.updateMany({
      where: {
        id: { in: registrations.map((item) => item.id) },
      },
      data: {
        notes: "Archived via attendee import rollback",
        source: "rollback_archive",
      },
    });

    await prisma.eventureAttendeeSlot.updateMany({
      where: {
        id: { in: attendeeSlots.map((item) => item.id) },
      },
      data: {
        notes: "Archived via attendee import rollback",
      },
    });

    return {
      importBatchId: input.importBatchId,
      status: "rolled_back",
      mode: "archive",
      warnings: ["Archive mode marks imported registrations and slots as rolled back but does not delete rows."],
      affectedCounts: preview.counts,
    };
  }

  await prisma.$transaction(async (tx) => {
    if (attendeeSlots.length > 0) {
      await tx.eventureAttendeeSlot.deleteMany({ where: { id: { in: attendeeSlots.map((item) => item.id) } } });
    }

    await tx.eventureRegistrationPaymentLog.deleteMany({
      where: {
        organizationId: input.organizationId,
        registrationId: {
          in: registrations.map((item) => item.id),
        },
      },
    });

    await tx.eventureRegistration.deleteMany({
      where: {
        id: { in: registrations.map((item) => item.id) },
      },
    });

    if (attendeeIds.length > 0) {
      await tx.eventureAttendee.deleteMany({
        where: {
          organizationId: input.organizationId,
          id: { in: attendeeIds },
          source: "import",
        },
      });
    }

    await tx.eventureImportRow.deleteMany({ where: { importBatchId: input.importBatchId } });
    await tx.eventureImportBatch.update({
      where: { id: input.importBatchId },
      data: {
        status: "rolled_back",
        rolledBackAt: new Date(),
        rollbackMode: "hard_delete",
      },
    });
  });

  return {
    importBatchId: input.importBatchId,
    status: "rolled_back",
    mode: "hard_delete",
    warnings: [],
    affectedCounts: preview.counts,
  };
}
