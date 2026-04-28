import crypto from "crypto";
import { prisma } from "../db/prisma.js";
import { FRONTEND_BASE_URL } from "../config/env.js";
import { sendInviteEmail } from "./email.service.js";

interface InviteRecord {
  id: string;
  organizationId: string;
  personnelId: string;
  recipientEmail: string;
  recipientName: string;
  assignedRole: string;
  assignedPosition: string;
  status: string;
  createdAt: Date;
  resentAt: Date | null;
}

interface InviteStore {
  missionHubInvite: {
    create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  };
  missionHubPersonnel: {
    update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
}

export class MissionHubInviteServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds?: number;

  constructor(message: string, status: number, code: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "MissionHubInviteServiceError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface IssueInviteInput {
  organizationId: string;
  personnelId: string;
  recipientEmail: string;
  recipientName: string;
  assignedRole: string;
  assignedPosition: string;
  createdByAdminId: string;
}

export interface InviteResult {
  inviteId: string;
  emailSent: boolean;
  emailStatus: "sent" | "failed" | "not_sent";
  inviteStatus: "invite_pending" | "invite_created";
  inviteLink: string;
}

function getInviteStore(): InviteStore {
  return prisma as unknown as InviteStore;
}

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

function buildInviteLink(rawToken: string): string {
  return `${FRONTEND_BASE_URL.replace(/\/$/, "")}/invite/accept?token=${encodeURIComponent(rawToken)}`;
}

export async function issueMissionHubInvite(input: IssueInviteInput): Promise<InviteResult> {
  const db = getInviteStore();
  const { raw, hash } = generateInviteToken();
  const expiresAt = inviteExpiresAt();
  const email = input.recipientEmail.trim().toLowerCase();

  const org = await prisma.organization.findUnique({ where: { id: input.organizationId } });

  const invite = await db.missionHubInvite.create({
    data: {
      organizationId: input.organizationId,
      personnelId: input.personnelId,
      recipientEmail: email,
      recipientName: input.recipientName,
      assignedRole: input.assignedRole,
      assignedPosition: input.assignedPosition,
      createdByAdminId: input.createdByAdminId,
      tokenHash: hash,
      expiresAt,
      status: "pending",
      emailStatus: "not_sent",
    },
  });

  let emailSent = false;
  if (email) {
    emailSent = await sendInviteEmail({
      to: email,
      recipientName: input.recipientName,
      organizationName: org?.name ?? "Your Organization",
      assignedRole: input.assignedRole,
      assignedPosition: input.assignedPosition,
      rawToken: raw,
    });
  }

  const inviteStatus = emailSent ? "invite_pending" : "invite_created";
  const emailStatus = emailSent ? "sent" : (email ? "failed" : "not_sent");

  await db.missionHubPersonnel.update({
    where: { id: input.personnelId },
    data: { inviteStatus },
  });

  await db.missionHubInvite.update({
    where: { id: invite.id as string },
    data: { emailStatus },
  });

  return {
    inviteId: invite.id as string,
    emailSent,
    emailStatus,
    inviteStatus,
    inviteLink: buildInviteLink(raw),
  };
}

export async function resendMissionHubInvite(
  organizationId: string,
  inviteId: string,
  cooldownMs: number,
): Promise<{ emailSent: boolean; inviteLink: string }> {
  const db = getInviteStore();
  const invite = await db.missionHubInvite.findFirst({
    where: { id: inviteId, organizationId },
  }) as InviteRecord | null;

  if (!invite) {
    throw new MissionHubInviteServiceError("Invite not found", 404, "invite_not_found");
  }
  if (invite.status === "accepted") {
    throw new MissionHubInviteServiceError("Invite already accepted", 409, "invite_already_accepted");
  }
  if (invite.status === "revoked") {
    throw new MissionHubInviteServiceError("Invite has been revoked", 409, "invite_revoked");
  }

  const lastSent = invite.resentAt ?? invite.createdAt;
  const msSinceLast = Date.now() - new Date(lastSent).getTime();
  if (msSinceLast < cooldownMs) {
    const retryAfterSeconds = Math.ceil((cooldownMs - msSinceLast) / 1000);
    throw new MissionHubInviteServiceError(
      "Resend too soon. Please wait before sending another invite.",
      429,
      "invite_resend_cooldown",
      retryAfterSeconds,
    );
  }

  const { raw, hash } = generateInviteToken();
  const expiresAt = inviteExpiresAt();
  const org = await prisma.organization.findUnique({ where: { id: organizationId } });

  const emailSent = await sendInviteEmail({
    to: invite.recipientEmail,
    recipientName: invite.recipientName,
    organizationName: org?.name ?? "Your Organization",
    assignedRole: invite.assignedRole,
    assignedPosition: invite.assignedPosition,
    rawToken: raw,
  });

  await db.missionHubInvite.update({
    where: { id: inviteId },
    data: {
      tokenHash: hash,
      expiresAt,
      status: "pending",
      emailStatus: emailSent ? "sent" : "failed",
      resentAt: new Date(),
    },
  });

  if (emailSent) {
    await db.missionHubPersonnel.update({
      where: { id: invite.personnelId },
      data: { inviteStatus: "invite_pending" },
    });
  }

  return { emailSent, inviteLink: buildInviteLink(raw) };
}
