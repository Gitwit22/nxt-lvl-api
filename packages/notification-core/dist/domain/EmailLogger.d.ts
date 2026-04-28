/**
 * notification-core/domain/EmailLogger.ts
 *
 * Contract for structured logging hooks within notification-core.
 * Adapters emit events; they do not decide where they go.
 */
import type { SendEmailInput, SendEmailResult } from './types.js';
export type NotificationLogAction = 'notification.email.sending' | 'notification.email.sent' | 'notification.email.failed' | 'notification.email.skipped';
export interface NotificationLogEvent {
    action: NotificationLogAction;
    /** Level hint for log routers. */
    level: 'debug' | 'info' | 'warn' | 'error';
    occurredAt: Date;
    input: Omit<SendEmailInput, 'html' | 'text'>;
    result?: SendEmailResult;
    /** Diagnostic message. */
    message: string;
    /** Optional extra context — must NOT include RESEND_API_KEY or credentials. */
    details?: Record<string, unknown>;
}
/**
 * EmailLogger is implemented by adapters that forward notification events to
 * logs, audit-core, or an external observability platform.
 */
export interface EmailLogger {
    log(event: NotificationLogEvent): void;
}
//# sourceMappingURL=EmailLogger.d.ts.map