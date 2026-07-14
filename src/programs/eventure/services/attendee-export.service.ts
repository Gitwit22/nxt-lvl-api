import { prisma } from "../../../core/db/prisma.js";
import { EventureServiceError } from "./eventure-error.js";

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export type AttendeeExportReportType =
  | "attendee-contact-list"
  | "flight-manifest"
  | "check-in-report"
  | "meal-dietary"
  | "badge-print";

export type AttendeeExportRow = Record<string, string>;

// ---------------------------------------------------------------------------
// Column definitions per report type
// ---------------------------------------------------------------------------

const REPORT_COLUMNS: Record<AttendeeExportReportType, string[]> = {
  "attendee-contact-list": [
    "First Name", "Last Name", "Email", "Phone",
    "Current Company", "Represented Company", "Participant/Sponsor", "Flight",
  ],
  "flight-manifest": [
    "First Name", "Last Name", "Email", "Company",
    "Participant/Sponsor", "Flight",
  ],
  "check-in-report": [
    "First Name", "Last Name", "Email", "Company",
    "Participant/Sponsor", "Flight", "Check-In Status",
  ],
  "meal-dietary": [
    "First Name", "Last Name", "Email", "Company",
    "Meal Preference", "Dietary Restrictions", "Dietary Override", "Accessibility Needs",
  ],
  "badge-print": [
    "First Name", "Last Name", "Company", "Represented Company",
    "Participant/Sponsor", "Flight", "Badge Printed",
  ],
};

// ---------------------------------------------------------------------------
// Raw slot query (one row per attendee assignment)
// ---------------------------------------------------------------------------

async function querySlots(organizationId: string, eventId: string) {
  return prisma.eventureAttendeeSlot.findMany({
    where: { organizationId, eventId },
    orderBy: [{ companyName: "asc" }, { slotNumber: "asc" }],
    include: {
      attendee: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          fullName: true,
          email: true,
          phone: true,
          company: true,
          title: true,
          dietaryRestrictions: true,
          accessibilityNeeds: true,
        },
      },
      representedCompany: { select: { id: true, name: true } },
      participant: {
        select: {
          id: true,
          companyName: true,
          contactCompany: { select: { name: true } },
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Flatten a slot to a full export row
// ---------------------------------------------------------------------------

function flattenSlot(
  slot: Awaited<ReturnType<typeof querySlots>>[number],
): AttendeeExportRow {
  const attendee = slot.attendee;
  const firstName = attendee?.firstName ?? slot.actualName?.split(" ")[0] ?? "";
  const lastName =
    attendee?.lastName ??
    (slot.actualName?.split(" ").slice(1).join(" ") || "") ??
    "";
  const displayedName = attendee?.fullName ?? slot.actualName ?? slot.displayName ?? "";

  const participantSponsor =
    slot.participant?.contactCompany?.name ?? slot.participant?.companyName ?? slot.companyName ?? "";

  return {
    "First Name": firstName,
    "Last Name": lastName,
    "Full Name": displayedName,
    Email: attendee?.email ?? "",
    Phone: attendee?.phone ?? "",
    "Current Company": attendee?.company ?? "",
    "Represented Company": slot.representedCompany?.name ?? slot.companyNameSnapshot ?? slot.companyName ?? "",
    "Participant/Sponsor": participantSponsor,
    Flight: slot.flightAssignment ?? "",
    "Check-In Status": slot.checkedIn ? "Checked In" : "Not Checked In",
    "Meal Preference": slot.mealPreference ?? "",
    "Dietary Restrictions": attendee?.dietaryRestrictions ?? "",
    "Dietary Override": slot.dietaryOverride ?? "",
    "Accessibility Needs": attendee?.accessibilityNeeds ?? "",
    "Badge Printed": slot.badgePrinted ? "Yes" : "No",
    Company: attendee?.company ?? slot.companyNameSnapshot ?? slot.companyName ?? "",
  };
}

// ---------------------------------------------------------------------------
// Build export rows
// ---------------------------------------------------------------------------

export async function buildAttendeeExportRows(
  eventId: string,
  organizationId: string,
  reportType: AttendeeExportReportType,
): Promise<{ columns: string[]; rows: AttendeeExportRow[] }> {
  const slots = await querySlots(organizationId, eventId);
  if (!slots.length) {
    const columns = REPORT_COLUMNS[reportType];
    if (!columns) throw new EventureServiceError(`Unknown report type: ${reportType}`, 400);
    return { columns, rows: [] };
  }

  const columns = REPORT_COLUMNS[reportType];
  if (!columns) throw new EventureServiceError(`Unknown report type: ${reportType}`, 400);

  const rows = slots.map(flattenSlot);
  return { columns, rows };
}

// ---------------------------------------------------------------------------
// CSV formatter
// ---------------------------------------------------------------------------

function escapeCSVCell(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function rowsToCSV(rows: AttendeeExportRow[], columns: string[]): string {
  const header = columns.map(escapeCSVCell).join(",");
  const body = rows
    .map((row) =>
      columns
        .map((col) => escapeCSVCell(row[col] ?? ""))
        .join(","),
    )
    .join("\n");
  return `${header}\n${body}`;
}
