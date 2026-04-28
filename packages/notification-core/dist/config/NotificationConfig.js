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
 * Throws a descriptive Error (not a silent undefined) when RESEND_API_KEY is
 * missing and EMAIL_SEND_ENABLED is not explicitly "false".
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
    if (!emailFrom) {
        // Warn loudly — 'no-reply@example.com' is a placeholder that will be
        // rejected by Resend unless the domain is verified in your account.
        // Set EMAIL_FROM to a sender address on a domain you have verified.
        console.warn('[notification-core] EMAIL_FROM is not set. ' +
            'Falling back to "no-reply@example.com", which will be rejected by Resend ' +
            'unless that domain is verified in your account. ' +
            'Set EMAIL_FROM to a verified sender address.');
    }
    return {
        resendApiKey,
        emailFrom: emailFrom ?? 'no-reply@example.com',
        emailReplyTo: process.env['EMAIL_REPLY_TO'],
        emailProvider: 'resend',
        sendEnabled,
        logLevel,
    };
}
//# sourceMappingURL=NotificationConfig.js.map