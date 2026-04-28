"use strict";
/**
 * notification-core/application/SendEmailUseCase.ts
 *
 * Orchestrates outbound email delivery without binding to a specific provider,
 * framework, or transport.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SendEmailUseCase = void 0;
const types_js_1 = require("../domain/types.js");
const validation_js_1 = require("../domain/validation.js");
/**
 * SendEmailUseCase coordinates the full email-send workflow:
 *  1. Checks whether sending is enabled; returns a skipped result if not.
 *  2. Validates that a provider API key is present.
 *  3. Delegates to the injected EmailProvider.
 *  4. Emits structured log events via the optional EmailLogger.
 */
class SendEmailUseCase {
    constructor(deps) {
        this.provider = deps.provider;
        this.config = deps.config;
        this.logger = deps.logger;
        this.now = deps.now ?? (() => new Date());
    }
    async execute(input) {
        const occurredAt = this.now();
        // ------------------------------------------------------------------
        // Guard: sending disabled
        // ------------------------------------------------------------------
        if (!this.config.sendEnabled) {
            const result = {
                success: false,
                skipped: true,
                reason: 'Email sending is disabled (EMAIL_SEND_ENABLED=false). ' +
                    'Set EMAIL_SEND_ENABLED=true to enable delivery.',
            };
            this.logger?.log({
                action: 'notification.email.skipped',
                level: 'info',
                occurredAt,
                input: this.stripBody(input),
                result,
                message: 'Email send skipped: sending is disabled.',
            });
            return result;
        }
        // ------------------------------------------------------------------
        // Guard: invalid input
        // ------------------------------------------------------------------
        const validationError = (0, validation_js_1.validateSendEmailInput)(input);
        if (validationError) {
            const result = { success: false, error: validationError };
            this.logger?.log({
                action: 'notification.email.failed',
                level: 'error',
                occurredAt,
                input: this.stripBody(input),
                result,
                message: `Email send failed: invalid input — ${validationError.message}`,
            });
            return result;
        }
        // ------------------------------------------------------------------
        // Guard: missing API key (defensive — loadNotificationConfig already
        // validates this, but guard here for programmatic construction paths)
        // ------------------------------------------------------------------
        if (!this.config.resendApiKey) {
            const error = (0, types_js_1.createNotificationError)(types_js_1.NotificationErrorCode.MISSING_API_KEY, 'RESEND_API_KEY is not configured. Cannot send email.');
            const result = { success: false, error };
            this.logger?.log({
                action: 'notification.email.failed',
                level: 'error',
                occurredAt,
                input: this.stripBody(input),
                result,
                message: 'Email send failed: missing API key.',
            });
            return result;
        }
        // ------------------------------------------------------------------
        // Delegate to provider
        // ------------------------------------------------------------------
        this.logger?.log({
            action: 'notification.email.sending',
            level: 'debug',
            occurredAt,
            input: this.stripBody(input),
            message: 'Sending email via provider.',
        });
        const result = await this.provider.send(input);
        this.logger?.log({
            action: result.success ? 'notification.email.sent' : 'notification.email.failed',
            level: result.success ? 'info' : 'error',
            occurredAt: this.now(),
            input: this.stripBody(input),
            result,
            message: result.success ? 'Email sent successfully.' : 'Email send failed.',
        });
        return result;
    }
    /** Strip html/text bodies before logging to avoid large payloads in logs. */
    stripBody(input) {
        const { html: _html, text: _text, ...rest } = input;
        return rest;
    }
}
exports.SendEmailUseCase = SendEmailUseCase;
//# sourceMappingURL=SendEmailUseCase.js.map