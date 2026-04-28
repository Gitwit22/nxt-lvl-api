/**
 * notification-core/domain/EmailProvider.ts
 *
 * Contract for a pluggable email delivery provider.
 * Concrete implementations (Resend, SMTP, mock) live in infrastructure/ and
 * are injected at runtime — this interface never references a specific SDK.
 */
import type { SendEmailInput, SendEmailResult } from './types.js';
/**
 * EmailProvider is implemented by adapters that forward outbound email to a
 * delivery service (e.g. Resend, SendGrid, SMTP).
 */
export interface EmailProvider {
    /**
     * Attempt to send one email.
     * Must never throw — all errors must be returned as a failed SendEmailResult.
     */
    send(input: SendEmailInput): Promise<SendEmailResult>;
}
//# sourceMappingURL=EmailProvider.d.ts.map