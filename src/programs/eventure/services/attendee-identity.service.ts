import { Prisma } from "@prisma/client";
import { normalizeEmail as _normalizeEmail, cleanPhone } from "./attendee-import-parser.js";
import { EventureServiceError } from "./eventure-error.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AttendeeIdentityInput = {
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  title?: string | null;
  companyId?: string | null;
  dietaryRestrictions?: string | null;
  accessibilityNeeds?: string | null;
  emergencyContact?: EmergencyContactInput | null;
  source?: string;
};

export type EmergencyContactInput = {
  name: string;
  phone: string;
  relationship?: string;
};

export type MatchReason =
  | "normalized_email"
  | "normalized_phone"
  | "name_and_company"
  | "no_match";

export type AttendeeMatchResult = {
  attendee: FoundAttendee;
  matchReason: MatchReason;
  confidence: "high" | "medium" | "low";
} | null;

type FoundAttendee = {
  id: string;
  organizationId: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string;
  email: string | null;
  normalizedEmail: string | null;
  phone: string | null;
  normalizedPhone: string | null;
  company: string | null;
  companyId: string | null;
  title: string | null;
  dietaryRestrictions: string | null;
  accessibilityNeeds: string | null;
  emergencyContact: Prisma.JsonValue;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateOrUpdateResult = {
  attendee: FoundAttendee;
  action: "created" | "matched" | "updated";
};

// ---------------------------------------------------------------------------
// Placeholder name detection
// ---------------------------------------------------------------------------

const PLACEHOLDER_PATTERNS = [
  /^(guest|tbd|tba|placeholder|empty|open|slot|seat|golfer|player|attendee|unknown|n\/?a)\s*\d*$/i,
  /^slot\s*#?\d+$/i,
  /^(ford|sponsor|company)\s*(golfer|player|guest|rep|representative)\s*\d*$/i,
  /^\s*$/,
];

export function isPlaceholderName(name?: string | null): boolean {
  if (!name) return true;
  const trimmed = name.trim();
  if (trimmed.length < 2) return true;
  return PLACEHOLDER_PATTERNS.some((re) => re.test(trimmed));
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

export function normalizeEmail(raw?: string | null): string | null {
  if (!raw) return null;
  const result = _normalizeEmail(raw);
  return result ?? null;
}

export function normalizePhone(raw?: string | null): string | null {
  if (!raw) return null;
  const result = cleanPhone(raw);
  return result ?? null;
}

function buildFullName(input: AttendeeIdentityInput): string {
  const first = (input.firstName ?? "").trim();
  const last = (input.lastName ?? "").trim();
  if (first && last) return `${first} ${last}`;
  if (first) return first;
  if (last) return last;
  return (input.fullName ?? "").trim();
}

// ---------------------------------------------------------------------------
// Match logic (all reads use the provided tx for consistency)
// ---------------------------------------------------------------------------

type PrismaTx = Parameters<Parameters<typeof import("../../../core/db/prisma.js")["prisma"]["$transaction"]>[0]>[0];

export async function findMatchingAttendee(
  tx: PrismaTx,
  organizationId: string,
  input: AttendeeIdentityInput,
): Promise<AttendeeMatchResult> {
  const nEmail = normalizeEmail(input.email);
  const nPhone = normalizePhone(input.phone);

  // Step 1: Exact normalized email
  if (nEmail) {
    const match = await tx.eventureAttendee.findFirst({
      where: { organizationId, normalizedEmail: nEmail, archivedAt: null },
    });
    if (match) return { attendee: match as FoundAttendee, matchReason: "normalized_email", confidence: "high" };
  }

  // Step 2: Exact normalized phone
  if (nPhone) {
    const match = await tx.eventureAttendee.findFirst({
      where: { organizationId, normalizedPhone: nPhone, archivedAt: null },
    });
    if (match) return { attendee: match as FoundAttendee, matchReason: "normalized_phone", confidence: "high" };
  }

  // Step 3: Name + company (medium confidence — may have multiple results)
  const firstName = (input.firstName ?? "").trim().toLowerCase();
  const lastName = (input.lastName ?? "").trim().toLowerCase();
  const company = (input.company ?? "").trim().toLowerCase();

  if (firstName && lastName && company) {
    const candidates = await tx.eventureAttendee.findMany({
      where: {
        organizationId,
        archivedAt: null,
        firstName: { equals: input.firstName ?? "", mode: "insensitive" },
        lastName: { equals: input.lastName ?? "", mode: "insensitive" },
        company: { equals: input.company ?? "", mode: "insensitive" },
      },
      take: 2,
    });
    if (candidates.length === 1) {
      return { attendee: candidates[0] as FoundAttendee, matchReason: "name_and_company", confidence: "medium" };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Create or update (upsert with resolution strategy)
// ---------------------------------------------------------------------------

export async function createOrUpdateAttendee(
  tx: PrismaTx,
  organizationId: string,
  input: AttendeeIdentityInput,
  userId?: string,
): Promise<CreateOrUpdateResult> {
  const nEmail = normalizeEmail(input.email);
  const nPhone = normalizePhone(input.phone);
  const fullName = buildFullName(input);

  // Emergency contact must be a plain object if provided
  const emergencyContactValue =
    input.emergencyContact != null
      ? (input.emergencyContact as unknown as Prisma.InputJsonValue)
      : Prisma.DbNull;

  const match = await findMatchingAttendee(tx, organizationId, input);

  if (match) {
    const { attendee } = match;
    // Patch any fields that became more complete
    const updated = await tx.eventureAttendee.update({
      where: { id: attendee.id },
      data: {
        email: input.email ?? attendee.email,
        normalizedEmail: nEmail ?? attendee.normalizedEmail,
        phone: input.phone ?? attendee.phone,
        normalizedPhone: nPhone ?? attendee.normalizedPhone,
        firstName: input.firstName ?? attendee.firstName,
        lastName: input.lastName ?? attendee.lastName,
        fullName: fullName || attendee.fullName,
        company: input.company ?? attendee.company,
        companyId: input.companyId ?? attendee.companyId,
        title: input.title ?? attendee.title,
        dietaryRestrictions: input.dietaryRestrictions ?? attendee.dietaryRestrictions,
        accessibilityNeeds: input.accessibilityNeeds ?? attendee.accessibilityNeeds,
        ...(input.emergencyContact != null ? { emergencyContact: emergencyContactValue } : {}),
        updatedByUserId: userId ?? null,
      },
    });
    const didChange =
      updated.email !== attendee.email ||
      updated.phone !== attendee.phone ||
      updated.firstName !== attendee.firstName ||
      updated.lastName !== attendee.lastName ||
      updated.company !== attendee.company;
    return { attendee: updated as FoundAttendee, action: didChange ? "updated" : "matched" };
  }

  // No match — create new record
  const created = await tx.eventureAttendee.create({
    data: {
      organizationId,
      fullName: fullName || "Unknown",
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      email: input.email ?? null,
      normalizedEmail: nEmail,
      phone: input.phone ?? null,
      normalizedPhone: nPhone,
      company: input.company ?? null,
      companyId: input.companyId ?? null,
      title: input.title ?? null,
      dietaryRestrictions: input.dietaryRestrictions ?? null,
      accessibilityNeeds: input.accessibilityNeeds ?? null,
      emergencyContact: emergencyContactValue,
      source: input.source ?? "manual",
      createdByUserId: userId ?? null,
      updatedByUserId: userId ?? null,
    },
  });
  return { attendee: created as FoundAttendee, action: "created" };
}

// ---------------------------------------------------------------------------
// Validate emergency contact shape
// ---------------------------------------------------------------------------

export function parseEmergencyContact(raw: unknown): EmergencyContactInput | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj["name"] !== "string" || typeof obj["phone"] !== "string") return null;
  return {
    name: obj["name"],
    phone: obj["phone"],
    relationship: typeof obj["relationship"] === "string" ? obj["relationship"] : undefined,
  };
}
