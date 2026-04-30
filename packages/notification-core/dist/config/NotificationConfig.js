"use strict";
/**
 * notification-core/config/NotificationConfig.ts
 *
 * Server-only environment configuration for notification-core.
 *
 * Rules:
 *  - Never use VITE_ prefixes — these variables must never reach the browser.
 *  - Never log RESEND_API_KEY.
 *  - If EMAIL_SEND_ENABLED=false the service simulates sends and returns a
 *    "skipped/disabled" result without calling the provider.
 *  - If RESEND_API_KEY is absent and sending is enabled, fail with a clear
 *    server-side error rather than a silent no-op.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadNotificationConfig = loadNotificationConfig;
// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------
/**
 * Reads notification configuration from environment variables.
 * Call this once at server startup to obtain a validated config object.
 *
 * Throws a descriptive Error when required variables are missing or invalid
 * and EMAIL_SEND_ENABLED is not explicitly "false".
 */
function loadNotificationConfig() {
    const sendEnabled = process.env['EMAIL_SEND_ENABLED'] !== 'false';
    const resendApiKey = process.env['RESEND_API_KEY'];
    if (sendEnabled && !resendApiKey) {
        throw new Error('[notification-core] RESEND_API_KEY is required when EMAIL_SEND_ENABLED is true. ' +
            'Set EMAIL_SEND_ENABLED=false to disable sending (e.g. in local development).');
    }
    const rawLogLevel = process.env['EMAIL_LOG_LEVEL'] ?? 'info';
    const logLevel = ['debug', 'info', 'warn', 'error'].includes(rawLogLevel)
        ? rawLogLevel
        : 'info';
    const emailFrom = process.env['EMAIL_FROM'];
    if (sendEnabled) {
        if (!emailFrom) {
            throw new Error('[notification-core] EMAIL_FROM is required when EMAIL_SEND_ENABLED is true. ' +
                'Set EMAIL_FROM to a verified sender address on your Resend-verified domain ' +
                '(e.g. "Nxt Lvl Technology Solutions <no-reply@nxtlvlts.com>").');
        }
        if (emailFrom.includes('@example.com')) {
            throw new Error(`[notification-core] EMAIL_FROM is set to "${emailFrom}", which uses @example.com. ` +
                'Resend will reject this with a 403 Domain not verified error. ' +
                'Set EMAIL_FROM to a verified sender address on your Resend-verified domain.');
        }
        console.info(`[notification-core] Email sending enabled — from: ${emailFrom}`);
    }
    else {
        console.info('[notification-core] Email sending is disabled (EMAIL_SEND_ENABLED=false). Emails will be skipped.');
    }
    return {
        resendApiKey,
        emailFrom: emailFrom ?? 'dev-null@disabled.local',
        emailReplyTo: process.env['EMAIL_REPLY_TO'],
        emailProvider: 'resend',
        sendEnabled,
        logLevel,
    };
}
//# sourceMappingURL=NotificationConfig.js.map