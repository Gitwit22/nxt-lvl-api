import { prisma } from "../../../core/db/prisma.js";
import type { Prisma } from "@prisma/client";

// ── Types ─────────────────────────────────────────────────────────────────

export type ActivityAction =
  | "slot.name_updated"
  | "slot.contact_updated"
  | "slot.checked_in"
  | "slot.checked_out"
  | "slot.badge_printed"
  | "participant.created"
  | "participant.removed"
  | "participant.flight_changed"
  | "participant.merged"
  | "participant.count_changed"
  | "payment.confirmed"
  | "payment.transaction_added"
  | "attendee.assigned"
  | "attendee.unassigned"
  | "import.completed";

export type ActivityTargetType =
  | "attendee_slot"
  | "participant"
  | "payment"
  | "import";

export type LogActivityInput = {
  organizationId: string;
  eventId: string;
  actorUserId?: string | null;
  actorName?: string | null;
  action: ActivityAction;
  targetType: ActivityTargetType;
  targetId?: string | null;
  targetLabel?: string | null;
  details?: Prisma.InputJsonValue | null;
};

export type ActivityLogEntry = {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  targetLabel: string | null;
  actorUserId: string | null;
  actorName: string | null;
  details: Prisma.JsonValue;
  createdAt: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────

// Human-readable label for each action
export const ACTION_LABELS: Record<string, string> = {
  "slot.name_updated": "Updated attendee name",
  "slot.contact_updated": "Updated contact info",
  "slot.checked_in": "Checked in",
  "slot.checked_out": "Checked out",
  "slot.badge_printed": "Badge printed",
  "participant.created": "Participant added",
  "participant.removed": "Participant removed",
  "participant.flight_changed": "Flight assignment changed",
  "participant.merged": "Participants merged",
  "participant.count_changed": "Attendee count changed",
  "payment.confirmed": "Payment confirmed",
  "payment.transaction_added": "Payment transaction recorded",
  "attendee.assigned": "Attendee assigned to slot",
  "attendee.unassigned": "Attendee unassigned from slot",
  "import.completed": "Import completed",
};

// ── Write ─────────────────────────────────────────────────────────────────

/**
 * Log an activity entry. Never throws — swallows errors silently so that
 * logging failures never block the primary operation.
 */
export async function logActivity(
  tx: typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  input: LogActivityInput,
): Promise<void> {
  try {
    await (tx as typeof prisma).eventureActivityLog.create({
      data: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        actorUserId: input.actorUserId ?? null,
        actorName: input.actorName ?? null,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        targetLabel: input.targetLabel ?? null,
        details: input.details ?? undefined,
      },
    });
  } catch {
    // Non-critical — do not propagate
  }
}

// ── Read ──────────────────────────────────────────────────────────────────

export async function listActivityLogForEvent(
  organizationId: string,
  eventId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<{ entries: ActivityLogEntry[]; total: number }> {
  const limit = Math.min(options.limit ?? 100, 500);
  const offset = options.offset ?? 0;

  const where = { organizationId, eventId };

  const [rows, total] = await Promise.all([
    prisma.eventureActivityLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      select: {
        id: true,
        action: true,
        targetType: true,
        targetId: true,
        targetLabel: true,
        actorUserId: true,
        actorName: true,
        details: true,
        createdAt: true,
      },
    }),
    prisma.eventureActivityLog.count({ where }),
  ]);

  return {
    entries: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
    })),
    total,
  };
}
