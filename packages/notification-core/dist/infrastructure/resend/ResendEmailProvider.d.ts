/**
 * notification-core/infrastructure/resend/ResendEmailProvider.ts
 *
 * Concrete EmailProvider adapter backed by the Resend SDK.
 * This is the only file in notification-core that imports from 'resend'.
 */
import type { NotificationConfig } from '../../config/NotificationConfig.js';
import type { EmailProvider } from '../../domain/EmailProvider.js';
import { type SendEmailInput, type SendEmailResult } from '../../domain/types.js';
/**
 * ResendEmailProvider delegates email delivery to the Resend API.
 * Construct it with a loaded NotificationConfig so the API key is
 * read from the server environment — never from client-side code.
 */
export declare class ResendEmailProvider implements EmailProvider {
    private readonly client;
    private readonly config;
    constructor(config: NotificationConfig);
    send(input: SendEmailInput): Promise<SendEmailResult>;
}
//# sourceMappingURL=ResendEmailProvider.d.ts.map