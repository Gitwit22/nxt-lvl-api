/**
 * notification-core/application/SendEmailUseCase.ts
 *
 * Orchestrates outbound email delivery without binding to a specific provider,
 * framework, or transport.
 */
import type { NotificationConfig } from '../config/NotificationConfig.js';
import type { EmailLogger } from '../domain/EmailLogger.js';
import type { EmailProvider } from '../domain/EmailProvider.js';
import { type SendEmailInput, type SendEmailResult } from '../domain/types.js';
export interface SendEmailUseCaseDependencies {
    provider: EmailProvider;
    config: NotificationConfig;
    logger?: EmailLogger;
    now?: () => Date;
}
/**
 * SendEmailUseCase coordinates the full email-send workflow:
 *  1. Checks whether sending is enabled; returns a skipped result if not.
 *  2. Validates that a provider API key is present.
 *  3. Delegates to the injected EmailProvider.
 *  4. Emits structured log events via the optional EmailLogger.
 */
export declare class SendEmailUseCase {
    private readonly provider;
    private readonly config;
    private readonly logger;
    private readonly now;
    constructor(deps: SendEmailUseCaseDependencies);
    execute(input: SendEmailInput): Promise<SendEmailResult>;
    /** Strip html/text bodies before logging to avoid large payloads in logs. */
    private stripBody;
}
//# sourceMappingURL=SendEmailUseCase.d.ts.map