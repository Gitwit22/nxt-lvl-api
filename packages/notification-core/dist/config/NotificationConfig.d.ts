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
export interface NotificationConfig {
    /** Resend API key. Required when sendEnabled is true. */
    resendApiKey: string | undefined;
    /** Default sender address used when SendEmailInput.from is not provided. */
    emailFrom: string;
    /** Default reply-to address. */
    emailReplyTo: string | undefined;
    /** Active email provider identifier (currently only "resend" is supported). */
    emailProvider: 'resend';
    /**
     * When false, the service skips the actual send and returns a skipped result.
     * Useful for local development or staging environments.
     */
    sendEnabled: boolean;
    /** Minimum log level emitted by the default console EmailLogger. */
    logLevel: 'debug' | 'info' | 'warn' | 'error';
}
/**
 * Reads notification configuration from environment variables.
 * Call this once at server startup to obtain a validated config object.
 *
 * Throws a descriptive Error (not a silent undefined) when RESEND_API_KEY is
 * missing and EMAIL_SEND_ENABLED is not explicitly "false".
 */
export declare function loadNotificationConfig(): NotificationConfig;
//# sourceMappingURL=NotificationConfig.d.ts.map