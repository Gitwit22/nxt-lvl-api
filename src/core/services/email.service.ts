import {
  loadNotificationConfig,
  ResendEmailProvider,
  SendEmailUseCase,
  ConsoleEmailLogger,
} from "@nxtlvl/notification-core";
import { FRONTEND_BASE_URL } from "../config/env.js";
import { logger } from "../../logger.js";

// ---------------------------------------------------------------------------
// Lazy singleton — avoids startup crashes if env vars are missing at boot.
// A failed init is cached so we don't retry on every request.
// ---------------------------------------------------------------------------
let _emailService: SendEmailUseCase | null = null;
let _emailServiceInitFailed = false;

function getEmailService(): SendEmailUseCase | null {
  if (_emailServiceInitFailed) return null;
  if (_emailService) return _emailService;
  try {
    const config = loadNotificationConfig();
    const provider = new ResendEmailProvider(config);
    const emailLogger = new ConsoleEmailLogger(config.logLevel);
    _emailService = new SendEmailUseCase({ provider, config, logger: emailLogger });
    return _emailService;
  } catch (err) {
    _emailServiceInitFailed = true;
    logger.warn("[email] Core email service failed to initialize — invite emails will be skipped", { err });
    return null;
  }
}

export interface InviteEmailParams {
  to: string;
  recipientName: string;
  organizationName: string;
  assignedRole: string;
  assignedPosition: string;
  rawToken: string;
}

export async function sendInviteEmail(params: InviteEmailParams): Promise<boolean> {
  const service = getEmailService();
  if (!service) {
    logger.warn("[email] Email service unavailable — skipping invite email", { to: params.to });
    return false;
  }

  const link = buildInviteLink(params.rawToken);
  const subject = "You've been invited to Mission Hub";
  const html = buildInviteHtml({ ...params, link });
  const text = buildInviteText({ ...params, link });

  const result = await service.execute({ to: params.to, subject, html, text });

  if (result.success) {
    logger.info("[email] Invite sent", { to: params.to });
    return true;
  }

  if ("skipped" in result && result.skipped) {
    logger.warn("[email] Invite email skipped (sending disabled)", { to: params.to });
  } else {
    logger.warn("[email] Invite email failed", {
      to: params.to,
      code: "error" in result ? (result as { success: false; error: { code: string } }).error?.code : undefined,
    });
  }
  return false;
}

function buildInviteLink(rawToken: string): string {
  return `${FRONTEND_BASE_URL.replace(/\/$/, "")}/invite/accept?token=${encodeURIComponent(rawToken)}`;
}

function buildInviteText(params: InviteEmailParams & { link: string }): string {
  const { recipientName, organizationName, assignedRole, assignedPosition, link } = params;
  const positionLine = assignedPosition ? `\nPosition: ${assignedPosition}` : "";
  return [
    `Hi ${recipientName},`,
    "",
    `You've been invited to join ${organizationName} on Mission Hub.`,
    `Role: ${assignedRole}${positionLine}`,
    "",
    "Click the link below to activate your account and set your password.",
    "This link expires in 7 days.",
    "",
    link,
    "",
    "If you didn't expect this invite, you can safely ignore this email.",
    "Questions? Email us at support@nxtlvlts.com",
  ].join("\n");
}

function buildInviteHtml(params: InviteEmailParams & { link: string }): string {
  const { recipientName, organizationName, assignedRole, assignedPosition, link } = params;
  const positionLine = assignedPosition ? `<p style="margin:4px 0;color:#555;">Position: ${assignedPosition}</p>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
        <tr><td style="background:#18181b;padding:28px 40px;">
          <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:700;">Nxt Lvl — Mission Hub</h1>
        </td></tr>
        <tr><td style="padding:36px 40px;">
          <p style="margin:0 0 16px;font-size:16px;color:#18181b;">Hi ${recipientName},</p>
          <p style="margin:0 0 24px;font-size:15px;color:#444;line-height:1.6;">
            You've been invited to join <strong>${organizationName}</strong> on Mission Hub.
          </p>
          <div style="background:#f9f9fb;border-radius:6px;padding:16px 20px;margin:0 0 28px;">
            <p style="margin:4px 0;color:#555;">Role: <strong style="color:#18181b;">${assignedRole}</strong></p>
            ${positionLine}
          </div>
          <p style="margin:0 0 24px;font-size:14px;color:#555;line-height:1.6;">
            Click the button below to activate your account and set your password.
            This link expires in <strong>7 days</strong>.
          </p>
          <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
            <tr><td style="background:#18181b;border-radius:6px;padding:14px 28px;">
              <a href="${link}" style="color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">Activate My Account</a>
            </td></tr>
          </table>
          <p style="margin:0 0 8px;font-size:12px;color:#888;">Or copy this link into your browser:</p>
          <p style="margin:0 0 32px;font-size:12px;color:#555;word-break:break-all;">${link}</p>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:0 0 24px;">
          <p style="margin:0;font-size:12px;color:#999;line-height:1.6;">
            If you didn't expect this invite, you can safely ignore this email.<br>
            Questions? Email us at <a href="mailto:support@nxtlvlts.com" style="color:#18181b;">support@nxtlvlts.com</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
