import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import { prisma } from "../../../core/db/prisma.js";
import {
  issueEventureInvite,
  resendEventureInvite,
  revokeEventureInvite,
  removeEventureInvite,
  EventureInviteServiceError,
} from "../services/eventure-invite.service.js";

const router = express.Router({ mergeParams: true });

function handleError(res: express.Response, error: unknown) {
  if (error instanceof EventureInviteServiceError) {
    const body: Record<string, unknown> = { error: error.message, code: error.code };
    if (error.retryAfterSeconds !== undefined) {
      res.set("Retry-After", String(error.retryAfterSeconds));
      body.retryAfterSeconds = error.retryAfterSeconds;
    }
    res.status(error.status).json(body);
    return;
  }
  console.error("[eventure:personnel]", error);
  res.status(500).json({ error: "Internal server error" });
}

// GET /api/eventure/personnel — list org personnel
router.get("/", requireAuth, async (req, res) => {
  try {
    const user = getRequestUser(req);
    if (!user) { res.status(401).json({ error: "Authentication required" }); return; }

    const includeArchived = req.query.includeArchived === "true";
    const items = await prisma.eventurePersonnel.findMany({
      where: {
        organizationId: user.organizationId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      include: { invite: true },
      orderBy: { createdAt: "asc" },
    });
    res.json({ items });
  } catch (error) { handleError(res, error); }
});

// POST /api/eventure/personnel — create personnel + issue invite
router.post("/", requireAuth, async (req, res) => {
  try {
    const user = getRequestUser(req);
    if (!user) { res.status(401).json({ error: "Authentication required" }); return; }

    const { name, email, programRole, notes } = req.body as {
      name?: string;
      email?: string;
      programRole?: string;
      notes?: string;
    };

    if (!name?.trim()) { res.status(400).json({ error: "name is required" }); return; }
    if (!email?.trim()) { res.status(400).json({ error: "email is required" }); return; }

    const normalizedEmail = email.trim().toLowerCase();

    // Prevent duplicate active personnel for the same org + email.
    // If an existing, not-yet-accepted personnel record exists, treat this as a re-invite.
    const existing = await prisma.eventurePersonnel.findFirst({
      where: { organizationId: user.organizationId, email: normalizedEmail, archivedAt: null },
    });
    if (existing) {
      if (!existing.userId && existing.inviteStatus !== "accepted") {
        const existingInvite = await prisma.eventureInvite.findFirst({
          where: { organizationId: user.organizationId, personnelId: existing.id },
        });

        if (existingInvite) {
          const inviteResult = await resendEventureInvite(user.organizationId, existingInvite.id, 0);
          const refreshed = await prisma.eventurePersonnel.findUnique({ where: { id: existing.id } });
          res.status(200).json({
            item: refreshed ?? existing,
            invite: {
              inviteId: existingInvite.id,
              emailSent: inviteResult.emailSent,
              emailStatus: inviteResult.emailSent ? "sent" : "failed",
              inviteStatus: inviteResult.emailSent ? "invite_pending" : "invite_created",
              inviteLink: inviteResult.inviteLink,
            },
            code: "existing_reinvited",
          });
          return;
        }

        const assignedRole = existing.programRole === "program_director"
          ? "Program Director"
          : "Team Member";

        const recreatedInvite = await issueEventureInvite({
          organizationId: user.organizationId,
          personnelId: existing.id,
          recipientEmail: existing.email,
          recipientName: existing.name,
          assignedRole,
          createdByAdminId: user.userId,
        });

        const refreshed = await prisma.eventurePersonnel.findUnique({ where: { id: existing.id } });
        res.status(200).json({
          item: refreshed ?? existing,
          invite: recreatedInvite,
          code: "existing_invite_recreated",
        });
        return;
      }

      res.status(409).json({ error: "A personnel record with this email already exists", code: "duplicate_email" });
      return;
    }

    const validProgramRoles = ["program_director"];
    const resolvedProgramRole = programRole && validProgramRoles.includes(programRole) ? programRole : undefined;

    const assignedRole = resolvedProgramRole === "program_director"
      ? "Program Director"
      : "Team Member";

    const personnel = await prisma.eventurePersonnel.create({
      data: {
        organizationId: user.organizationId,
        name: name.trim(),
        email: normalizedEmail,
        programRole: resolvedProgramRole ?? null,
        notes: notes?.trim() ?? null,
        inviteStatus: "none",
      },
    });

    const inviteResult = await issueEventureInvite({
      organizationId: user.organizationId,
      personnelId: personnel.id,
      recipientEmail: normalizedEmail,
      recipientName: name.trim(),
      assignedRole,
      createdByAdminId: user.userId,
    });

    res.status(201).json({ item: { ...personnel, inviteStatus: inviteResult.inviteStatus }, invite: inviteResult });
  } catch (error) { handleError(res, error); }
});

// GET /api/eventure/personnel/:personnelId — get single personnel
router.get("/:personnelId", requireAuth, async (req, res) => {
  try {
    const user = getRequestUser(req);
    if (!user) { res.status(401).json({ error: "Authentication required" }); return; }

    const { personnelId } = req.params as { personnelId: string };
    const item = await prisma.eventurePersonnel.findFirst({
      where: { id: personnelId, organizationId: user.organizationId },
      include: { invite: true, eventAssignments: { where: { archivedAt: null }, include: { event: { select: { id: true, title: true, startDateTime: true, status: true } } } } },
    });
    if (!item) { res.status(404).json({ error: "Personnel not found" }); return; }
    res.json({ item });
  } catch (error) { handleError(res, error); }
});

// PATCH /api/eventure/personnel/:personnelId — update name / programRole / notes
router.patch("/:personnelId", requireAuth, async (req, res) => {
  try {
    const user = getRequestUser(req);
    if (!user) { res.status(401).json({ error: "Authentication required" }); return; }

    const { personnelId } = req.params as { personnelId: string };
    const existing = await prisma.eventurePersonnel.findFirst({
      where: { id: personnelId, organizationId: user.organizationId, archivedAt: null },
    });
    if (!existing) { res.status(404).json({ error: "Personnel not found" }); return; }

    const { name, programRole, notes } = req.body as { name?: string; programRole?: string | null; notes?: string | null };

    const validProgramRoles = ["program_director"];
    const resolvedProgramRole = programRole === null
      ? null
      : programRole && validProgramRoles.includes(programRole)
        ? programRole
        : undefined;

    const updated = await prisma.eventurePersonnel.update({
      where: { id: personnelId },
      data: {
        ...(name?.trim() ? { name: name.trim() } : {}),
        ...(resolvedProgramRole !== undefined ? { programRole: resolvedProgramRole } : {}),
        ...(notes !== undefined ? { notes: notes?.trim() ?? null } : {}),
      },
    });
    res.json({ item: updated });
  } catch (error) { handleError(res, error); }
});

// DELETE /api/eventure/personnel/:personnelId — archive (soft-delete)
router.delete("/:personnelId", requireAuth, async (req, res) => {
  try {
    const user = getRequestUser(req);
    if (!user) { res.status(401).json({ error: "Authentication required" }); return; }

    const { personnelId } = req.params as { personnelId: string };
    const existing = await prisma.eventurePersonnel.findFirst({
      where: { id: personnelId, organizationId: user.organizationId, archivedAt: null },
    });
    if (!existing) { res.status(404).json({ error: "Personnel not found" }); return; }

    await prisma.eventurePersonnel.update({
      where: { id: personnelId },
      data: { archivedAt: new Date() },
    });
    res.json({ ok: true });
  } catch (error) { handleError(res, error); }
});

// POST /api/eventure/personnel/:personnelId/invite/resend — resend invite
router.post("/:personnelId/invite/resend", requireAuth, async (req, res) => {
  try {
    const user = getRequestUser(req);
    if (!user) { res.status(401).json({ error: "Authentication required" }); return; }

    const { personnelId } = req.params as { personnelId: string };
    const invite = await prisma.eventureInvite.findFirst({
      where: { personnelId, organizationId: user.organizationId },
    });
    if (!invite) { res.status(404).json({ error: "No invite found for this personnel" }); return; }

    const result = await resendEventureInvite(user.organizationId, invite.id);
    res.json(result);
  } catch (error) { handleError(res, error); }
});

// POST /api/eventure/personnel/:personnelId/invite/revoke — revoke active invite
router.post("/:personnelId/invite/revoke", requireAuth, async (req, res) => {
  try {
    const user = getRequestUser(req);
    if (!user) { res.status(401).json({ error: "Authentication required" }); return; }

    const { personnelId } = req.params as { personnelId: string };
    const invite = await prisma.eventureInvite.findFirst({
      where: { personnelId, organizationId: user.organizationId },
    });
    if (!invite) { res.status(404).json({ error: "No invite found for this personnel" }); return; }

    const result = await revokeEventureInvite(user.organizationId, invite.id);
    res.json(result);
  } catch (error) { handleError(res, error); }
});

// DELETE /api/eventure/personnel/:personnelId/invite — remove invite record
router.delete("/:personnelId/invite", requireAuth, async (req, res) => {
  try {
    const user = getRequestUser(req);
    if (!user) { res.status(401).json({ error: "Authentication required" }); return; }

    const { personnelId } = req.params as { personnelId: string };
    const invite = await prisma.eventureInvite.findFirst({
      where: { personnelId, organizationId: user.organizationId },
    });
    if (!invite) { res.status(404).json({ error: "No invite found for this personnel" }); return; }

    const result = await removeEventureInvite(user.organizationId, invite.id);
    res.json(result);
  } catch (error) { handleError(res, error); }
});

export { router as eventurePersonnelRouter };
