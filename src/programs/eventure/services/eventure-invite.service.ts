import crypto from "crypto";
import { prisma } from "../../../core/db/prisma.js";
import { EVENTURE_APP_URL } from "../../../core/config/env.js";
import { sendEventurePersonnelInviteEmail } from "../../../core/services/email.service.js";

// ─── Errors ──────────────────────────────────────────────────────────────────

export class EventureInviteServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds?: number;

  constructor(message: string, status: number, code: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "EventureInviteServiceError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IssueEventureInviteInput {
  organizationId: string;
  personnelId: string;
  recipientEmail: string;
  recipientName: string;
  /** Human-readable role label used in the email body */
  assignedRole: string;
  createdByAdminId: string;
}

export interface EventureInviteResult {
  inviteId: string;
  emailSent: boolean;
  emailStatus: "sent" | "failed" | "not_sent";
  inviteStatus: "invite_pending" | "invite_created";
  inviteLink: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function generateInviteToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString("hex");
  return { raw, hash: hashToken(raw) };
}

function inviteExpiresAt(): Date {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
}

const EVENTURE_APP_BASE_URL = EVENTURE_APP_URL.replace(/\/$/, "");

function buildInviteLink(rawToken: string): string {
  return `${EVENTURE_APP_BASE_URL}/eventure/invite/accept?token=${encodeURIComponent(rawToken)}`;
}

// ─── Issue Invite ─────────────────────────────────────────────────────────────

export async function issueEventureInvite(input: IssueEventureInviteInput): Promise<EventureInviteResult> {
  const { raw, hash } = generateInviteToken();
  const expiresAt = inviteExpiresAt();
  const email = input.recipientEmail.trim().toLowerCase();

  const org = await prisma.organization.findUnique({ where: { id: input.organizationId } });

  const invite = await prisma.eventureInvite.create({
    data: {
      organizationId: input.organizationId,
      personnelId: input.personnelId,
      recipientEmail: email,
      recipientName: input.recipientName,
      assignedRole: input.assignedRole,
      createdByAdminId: input.createdByAdminId,
      tokenHash: hash,
      expiresAt,
      status: "pending",
      emailStatus: "not_sent",
    },
  });

  let emailSent = false;
  if (email) {
    emailSent = await sendEventurePersonnelInviteEmail({
      to: email,
      recipientName: input.recipientName,
      organizationName: org?.name ?? "Your Organization",
      assignedRole: input.assignedRole,
      rawToken: raw,
    });
  }

  const inviteStatus = emailSent ? "invite_pending" : "invite_created";
  const emailStatus: "sent" | "failed" | "not_sent" = emailSent ? "sent" : email ? "failed" : "not_sent";

  await prisma.eventurePersonnel.update({
    where: { id: input.personnelId },
    data: { inviteStatus },
  });

  await prisma.eventureInvite.update({
    where: { id: invite.id },
    data: { emailStatus },
  });

  return {
    inviteId: invite.id,
    emailSent,
    emailStatus,
    inviteStatus,
    inviteLink: buildInviteLink(raw),
  };
}

// ─── Resend Invite ────────────────────────────────────────────────────────────

export async function resendEventureInvite(
  organizationId: string,
  inviteId: string,
  cooldownMs = 60_000,
): Promise<{ emailSent: boolean; inviteLink: string }> {
  const invite = await prisma.eventureInvite.findFirst({
    where: { id: inviteId, organizationId },
  });

  if (!invite) {
    throw new EventureInviteServiceError("Invite not found", 404, "invite_not_found");
  }
  if (invite.status === "accepted") {
    throw new EventureInviteServiceError("Invite already accepted", 409, "invite_already_accepted");
  }

  const lastSent = invite.resentAt ?? invite.createdAt;
  const msSinceLast = Date.now() - new Date(lastSent).getTime();
  if (msSinceLast < cooldownMs) {
    const retryAfterSeconds = Math.ceil((cooldownMs - msSinceLast) / 1000);
    throw new EventureInviteServiceError(
      "Resend too soon. Please wait before sending another invite.",
      429,
      "invite_resend_cooldown",
      retryAfterSeconds,
    );
  }

  const { raw, hash } = generateInviteToken();
  const expiresAt = inviteExpiresAt();
  const org = await prisma.organization.findUnique({ where: { id: organizationId } });

  const emailSent = await sendEventurePersonnelInviteEmail({
    to: invite.recipientEmail,
    recipientName: invite.recipientName,
    organizationName: org?.name ?? "Your Organization",
    assignedRole: invite.assignedRole,
    rawToken: raw,
  });

  await prisma.eventureInvite.update({
    where: { id: inviteId },
    data: {
      tokenHash: hash,
      expiresAt,
      status: "pending",
      emailStatus: emailSent ? "sent" : "failed",
      resentAt: new Date(),
    },
  });

  await prisma.eventurePersonnel.update({
    where: { id: invite.personnelId },
    data: { inviteStatus: emailSent ? "invite_pending" : "invite_created" },
  });

  return { emailSent, inviteLink: buildInviteLink(raw) };
}

// ─── Revoke / Remove Invite ─────────────────────────────────────────────────

export async function revokeEventureInvite(
  organizationId: string,
  inviteId: string,
): Promise<{ ok: true; status: "revoked" }> {
  const invite = await prisma.eventureInvite.findFirst({
    where: { id: inviteId, organizationId },
  });

  if (!invite) {
    throw new EventureInviteServiceError("Invite not found", 404, "invite_not_found");
  }
  if (invite.status === "accepted") {
    throw new EventureInviteServiceError("Invite already accepted", 409, "invite_already_accepted");
  }

  await prisma.$transaction([
    prisma.eventureInvite.update({
      where: { id: invite.id },
      data: {
        status: "revoked",
        revokedAt: invite.revokedAt ?? new Date(),
      },
    }),
    prisma.eventurePersonnel.update({
      where: { id: invite.personnelId },
      data: { inviteStatus: "revoked" },
    }),
  ]);

  return { ok: true, status: "revoked" };
}

export async function removeEventureInvite(
  organizationId: string,
  inviteId: string,
): Promise<{ ok: true }> {
  const invite = await prisma.eventureInvite.findFirst({
    where: { id: inviteId, organizationId },
  });

  if (!invite) {
    throw new EventureInviteServiceError("Invite not found", 404, "invite_not_found");
  }
  if (invite.status === "accepted") {
    throw new EventureInviteServiceError("Accepted invites cannot be removed", 409, "invite_already_accepted");
  }

  await prisma.$transaction([
    prisma.eventureInvite.delete({ where: { id: invite.id } }),
    prisma.eventurePersonnel.update({
      where: { id: invite.personnelId },
      data: { inviteStatus: "none" },
    }),
  ]);

  return { ok: true };
}

// ─── Validate Token ───────────────────────────────────────────────────────────

export async function validateEventureInviteToken(rawToken: string) {
  const hash = hashToken(rawToken);
  const invite = await prisma.eventureInvite.findUnique({
    where: { tokenHash: hash },
    include: { personnel: true },
  });

  if (!invite) {
    throw new EventureInviteServiceError("Invalid or expired invite link", 404, "invite_not_found");
  }
  if (invite.status === "accepted") {
    throw new EventureInviteServiceError("This invite has already been used", 409, "invite_already_accepted");
  }
  if (invite.status === "revoked") {
    throw new EventureInviteServiceError("This invite has been revoked", 410, "invite_revoked");
  }
  if (new Date() > invite.expiresAt) {
    await prisma.eventureInvite.update({ where: { id: invite.id }, data: { status: "expired" } });
    throw new EventureInviteServiceError("This invite link has expired", 410, "invite_expired");
  }

  const org = await prisma.organization.findUnique({ where: { id: invite.organizationId } });

  return {
    inviteId: invite.id,
    organizationId: invite.organizationId,
    organizationName: org?.name ?? "Your Organization",
    personnelId: invite.personnelId,
    recipientEmail: invite.recipientEmail,
    recipientName: invite.recipientName,
    assignedRole: invite.assignedRole,
    expiresAt: invite.expiresAt,
  };
}

// ─── Accept Invite ────────────────────────────────────────────────────────────

export interface AcceptEventureInviteInput {
  rawToken: string;
  password: string;
  displayName?: string;
}

export async function acceptEventureInvite(input: AcceptEventureInviteInput) {
  const metadata = await validateEventureInviteToken(input.rawToken);
  const hash = hashToken(input.rawToken);

  // Hash password before the transaction — bcrypt is CPU-intensive and should not hold a DB connection open
  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.hash(input.password, 12);

  const name = input.displayName ?? metadata.recipientName;
  const email = metadata.recipientEmail.trim().toLowerCase();

  const result = await prisma.$transaction(async (tx) => {
    // Create or update user account.
    // If a user already exists (e.g. re-invited or pre-existing account), update their
    // password and display name with what they entered on the invite form.
    let user = await tx.user.findFirst({ where: { email } });
    if (!user) {
      user = await tx.user.create({
        data: {
          email,
          displayName: name,
          passwordHash,
          role: "uploader",
          platformRole: "user",
          organizationId: metadata.organizationId,
        },
      });
    } else {
      user = await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          displayName: name,
          organizationId: metadata.organizationId,
        },
      });
    }

    // Ensure org membership
    const existingMembership = await tx.membership.findFirst({
      where: { userId: user.id, organizationId: metadata.organizationId },
    });
    if (!existingMembership) {
      await tx.membership.create({
        data: {
          userId: user.id,
          organizationId: metadata.organizationId,
          role: "member",
        },
      });
    }

    // Link personnel record
    await tx.eventurePersonnel.update({
      where: { id: metadata.personnelId },
      data: { userId: user.id, inviteStatus: "accepted" },
    });

    // Mark invite accepted
    await tx.eventureInvite.update({
      where: { tokenHash: hash },
      data: { status: "accepted", acceptedAt: new Date() },
    });

    return { userId: user.id, email: user.email };
  });

  return result;
}
