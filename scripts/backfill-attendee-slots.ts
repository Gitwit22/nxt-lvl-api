/**
 * Backfill: Link existing named AttendeeSlots to EventureAttendee records.
 *
 * Run manually ONCE after the add_attendee_canonical_identity migration.
 * Without --apply the script always runs in dry-run mode — no data is written.
 *
 * Usage:
 *   # Step 1 — review (always safe, no writes)
 *   npx tsx scripts/backfill-attendee-slots.ts --org <organizationId>
 *
 *   # Step 2 — write after reviewing the audit JSON
 *   npx tsx scripts/backfill-attendee-slots.ts --org <organizationId> --apply
 *
 *   # All orgs (omit --org)
 *   npx tsx scripts/backfill-attendee-slots.ts --apply
 *
 * Flags:
 *   --apply              Enable writes. Without this flag the script is always a dry run.
 *   --org <id>           Scope to a single organization.
 *
 * Decision categories:
 *   linked              — Existing EventureAttendee matched by name+company; attendeeId set.
 *   created             — No match; real-looking name; new EventureAttendee created + linked.
 *   ambiguous           — Multiple possible matches; slot unchanged — manual review required.
 *   placeholder_skipped — Name matches placeholder pattern (Guest 1, TBD…); skipped.
 *   empty_slot_skipped  — No usable name; skipped.
 *   already_linked      — slot.attendeeId already set; skipped.
 *   error               — Unexpected exception; slot unchanged; see error field in audit.
 *
 * Output:
 *   Decision summary printed to stdout.
 *   Audit JSON written to ./backfill-audit-<timestamp>[-dry-run].json.
 *   Audit is always written BEFORE any database writes.
 */

import { writeFileSync } from "fs";
import { PrismaClient } from "@prisma/client";
import {
  isPlaceholderName,
} from "../src/programs/eventure/services/attendee-identity.service.js";

const prisma = new PrismaClient();

// ── Types ─────────────────────────────────────────────────────────────────────

type BackfillDecision =
  | "linked"
  | "created"
  | "ambiguous"
  | "placeholder_skipped"
  | "empty_slot_skipped"
  | "already_linked"
  | "error";

type AuditEntry = {
  slotId: string;
  eventId: string;
  participantId: string;
  organizationId: string;
  slotNumber: number;
  originalActualName: string | null;
  originalDisplayName: string;
  selectedAttendeeId: string | null;
  selectedAttendeeName: string | null;
  classification: BackfillDecision;
  matchReason: string;
  action: "written" | "would_write" | "skipped" | "error";
  error: string | null;
};

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const applyWrites = args.includes("--apply");
  const orgIdx = args.indexOf("--org");
  const organizationId = orgIdx !== -1 ? args[orgIdx + 1] : undefined;
  return { applyWrites, organizationId };
}

function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const { applyWrites, organizationId } = parseArgs();
  const dryRun = !applyWrites;

  console.log(`\n=== Attendee Slot Backfill ${dryRun ? "(DRY RUN — no writes)" : "(LIVE — writes enabled)"} ===`);
  if (organizationId) console.log(`Scoped to org: ${organizationId}`);
  if (dryRun) console.log(`\nTo enable writes, add --apply to the command.`);
  console.log();

  const slots = await prisma.eventureAttendeeSlot.findMany({
    where: { ...(organizationId ? { organizationId } : {}) },
    select: {
      id: true,
      organizationId: true,
      eventId: true,
      participantId: true,
      slotNumber: true,
      actualName: true,
      displayName: true,
      companyName: true,
      attendeeId: true,
    },
    orderBy: [{ organizationId: "asc" }, { eventId: "asc" }, { slotNumber: "asc" }],
  });

  console.log(`Found ${slots.length} total slots to evaluate.\n`);

  const entries: AuditEntry[] = [];
  const counts: Record<BackfillDecision, number> = {
    linked: 0, created: 0, ambiguous: 0,
    placeholder_skipped: 0, empty_slot_skipped: 0, already_linked: 0, error: 0,
  };

  for (const slot of slots) {
    const entry: AuditEntry = {
      slotId: slot.id,
      eventId: slot.eventId,
      participantId: slot.participantId,
      organizationId: slot.organizationId,
      slotNumber: slot.slotNumber,
      originalActualName: slot.actualName ?? null,
      originalDisplayName: slot.displayName,
      selectedAttendeeId: null,
      selectedAttendeeName: null,
      classification: "error",
      matchReason: "",
      action: "error",
      error: null,
    };

    try {
      // Already linked — skip regardless of apply flag
      if (slot.attendeeId) {
        entry.classification = "already_linked";
        entry.selectedAttendeeId = slot.attendeeId;
        entry.matchReason = "attendeeId already set.";
        entry.action = "skipped";
        counts.already_linked++;
        entries.push(entry);
        continue;
      }

      const name = slot.actualName?.trim() || slot.displayName?.trim() || "";

      // Empty slot
      if (!name) {
        entry.classification = "empty_slot_skipped";
        entry.matchReason = "No usable name.";
        entry.action = "skipped";
        counts.empty_slot_skipped++;
        entries.push(entry);
        continue;
      }

      // Placeholder
      if (isPlaceholderName(name)) {
        entry.classification = "placeholder_skipped";
        entry.matchReason = `Placeholder name pattern detected: "${name}".`;
        entry.action = "skipped";
        counts.placeholder_skipped++;
        entries.push(entry);
        continue;
      }

      const { firstName, lastName } = splitName(name);

      // Match by name + company
      const candidates = await prisma.eventureAttendee.findMany({
        where: {
          organizationId: slot.organizationId,
          archivedAt: null,
          firstName: { equals: firstName, mode: "insensitive" },
          ...(lastName ? { lastName: { equals: lastName, mode: "insensitive" } } : {}),
          ...(slot.companyName ? { company: { equals: slot.companyName, mode: "insensitive" } } : {}),
        },
        take: 3,
        select: { id: true, fullName: true },
      });

      if (candidates.length > 1) {
        entry.classification = "ambiguous";
        entry.matchReason = `${candidates.length} possible matches — manual review required.`;
        entry.action = "skipped";
        counts.ambiguous++;
        entries.push(entry);
        continue;
      }

      if (candidates.length === 1) {
        const matched = candidates[0];
        entry.classification = "linked";
        entry.selectedAttendeeId = matched.id;
        entry.selectedAttendeeName = matched.fullName;
        entry.matchReason = `name+company match: "${matched.fullName}" (${matched.id}).`;

        if (applyWrites) {
          await prisma.eventureAttendeeSlot.update({
            where: { id: slot.id },
            data: { attendeeId: matched.id },
          });
          entry.action = "written";
        } else {
          entry.action = "would_write";
        }
        counts.linked++;
        entries.push(entry);
        continue;
      }

      // No match — create new attendee from slot data
      entry.classification = "created";
      entry.matchReason = "No existing match found.";

      if (applyWrites) {
        const created = await prisma.eventureAttendee.create({
          data: {
            organizationId: slot.organizationId,
            fullName: name,
            firstName: firstName || null,
            lastName: lastName || null,
            company: slot.companyName ?? null,
            source: "backfill",
            createdByUserId: "system-backfill",
          },
        });
        await prisma.eventureAttendeeSlot.update({
          where: { id: slot.id },
          data: { attendeeId: created.id },
        });
        entry.selectedAttendeeId = created.id;
        entry.selectedAttendeeName = name;
        entry.action = "written";
      } else {
        entry.selectedAttendeeName = name;
        entry.action = "would_write";
      }
      counts.created++;
      entries.push(entry);

    } catch (err) {
      entry.classification = "error";
      entry.action = "error";
      entry.error = err instanceof Error ? err.message : String(err);
      counts.error++;
      console.error(`ERROR slot ${slot.id}:`, entry.error);
      entries.push(entry);
    }
  }

  // ── Print summary ──────────────────────────────────────────────────────────

  console.log("=== Decision Summary ===");
  for (const [k, v] of Object.entries(counts)) {
    if (v > 0) console.log(`  ${k.padEnd(26)} ${v}`);
  }
  console.log(`  ${"total".padEnd(26)} ${slots.length}\n`);

  const ambiguous = entries.filter((e) => e.classification === "ambiguous");
  if (ambiguous.length > 0) {
    console.log("=== Ambiguous — manual review required ===");
    for (const e of ambiguous) {
      const name = e.originalActualName || e.originalDisplayName;
      console.log(`  Slot ${e.slotId} | org ${e.organizationId} | "${name}" | ${e.matchReason}`);
    }
    console.log();
  }

  if (counts.error > 0) {
    console.log(`=== Errors (${counts.error}) — see audit file for details ===\n`);
  }

  // ── Write audit JSON (always, before any writes complete) ──────────────────

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = dryRun ? "-dry-run" : "-applied";
  const auditPath = `./backfill-audit-${timestamp}${suffix}.json`;
  writeFileSync(
    auditPath,
    JSON.stringify(
      {
        dryRun,
        appliedWrites: applyWrites,
        organizationId: organizationId ?? "all",
        counts,
        entries,
      },
      null,
      2,
    ),
  );
  console.log(`Audit file: ${auditPath}`);

  if (dryRun) {
    console.log("\n[DRY RUN] No changes written. Add --apply to commit.\n");
  } else {
    console.log("\n[APPLIED] All writes committed to database.\n");
  }
}

run()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
