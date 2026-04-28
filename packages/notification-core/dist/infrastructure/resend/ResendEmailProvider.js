"use strict";
/**
 * notification-core/infrastructure/resend/ResendEmailProvider.ts
 *
 * Concrete EmailProvider adapter backed by the Resend SDK.
 * This is the only file in notification-core that imports from 'resend'.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResendEmailProvider = void 0;
const resend_1 = require("resend");
const types_js_1 = require("../../domain/types.js");
/**
 * Normalizes an EmailAddress (string | { name; email }) to the format
 * expected by the Resend SDK ("email" or "Name <email>").
 */
function formatAddress(address) {
    if (typeof address === 'string') {
        return address;
    }
    return `${address.name} <${address.email}>`;
}
function formatAddresses(value) {
    if (value === undefined)
        return undefined;
    if (Array.isArray(value))
        return value.map(formatAddress);
    return formatAddress(value);
}
/**
 * ResendEmailProvider delegates email delivery to the Resend API.
 * Construct it with a loaded NotificationConfig so the API key is
 * read from the server environment — never from client-side code.
 */
class ResendEmailProvider {
    constructor(config) {
        if (!config.resendApiKey) {
            throw new Error('[ResendEmailProvider] Cannot instantiate provider without a RESEND_API_KEY.');
        }
        this.config = config;
        this.client = new resend_1.Resend(config.resendApiKey);
    }
    async send(input) {
        try {
            const from = input.from ?? this.config.emailFrom;
            const replyTo = input.replyTo ?? this.config.emailReplyTo;
            const { data, error } = await this.client.emails.send({
                from,
                to: formatAddresses(input.to),
                subject: input.subject,
                html: input.html,
                text: input.text,
                replyTo,
                cc: formatAddresses(input.cc),
                bcc: formatAddresses(input.bcc),
            });
            if (error !== null && error !== undefined) {
                return {
                    success: false,
                    error: (0, types_js_1.createNotificationError)(types_js_1.NotificationErrorCode.PROVIDER_ERROR, error.message, { name: error.name }),
                };
            }
            return {
                success: true,
                messageId: data?.id ?? '',
            };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                success: false,
                error: (0, types_js_1.createNotificationError)(types_js_1.NotificationErrorCode.PROVIDER_ERROR, `Resend SDK threw an unexpected error: ${message}`, err),
            };
        }
    }
}
exports.ResendEmailProvider = ResendEmailProvider;
//# sourceMappingURL=ResendEmailProvider.js.map