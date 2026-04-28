/**
 * notification-core/domain/types.ts
 *
 * Core domain types for the notification-core module.
 * These are application-agnostic and must not reference any specific framework,
 * transport, or product. All concrete implementations live in infrastructure/.
 */
/**
 * An email address as either a plain string ("user@example.com") or a named
 * object ({ name: "Alice", email: "alice@example.com" }).
 */
export type EmailAddress = string | {
    name: string;
    email: string;
};
/**
 * Input required to send a single email through the notification service.
 */
export interface SendEmailInput {
    /** One or more recipient addresses. */
    to: EmailAddress | EmailAddress[];
    /** Email subject line. */
    subject: string;
    /** HTML body of the email. At least one of html or text should be provided. */
    html?: string;
    /** Plain-text body of the email. */
    text?: string;
    /**
     * Sender address. Overrides the EMAIL_FROM environment variable when
     * provided. Must be a verified sender in your Resend account.
     */
    from?: string;
    /** Reply-to address. Overrides EMAIL_REPLY_TO when provided. */
    replyTo?: string;
    /** Carbon-copy recipients. */
    cc?: EmailAddress | EmailAddress[];
    /** Blind carbon-copy recipients. */
    bcc?: EmailAddress | EmailAddress[];
    /**
     * File attachments.
     * Typed now for forward-compatibility; not yet implemented in the provider.
     */
    attachments?: EmailAttachment[];
    /**
     * Optional program domain slug (e.g. "streamline", "community-chronicle").
     * Used for logging and metadata only — not sent to the email provider.
     */
    programDomain?: string;
    /** Optional organization identifier for tracing and audit logs. */
    organizationId?: string;
    /** Optional user identifier for tracing and audit logs. */
    userId?: string;
    /** Optional template key used to resolve a pre-registered template. */
    templateKey?: string;
    /** Arbitrary key/value metadata for downstream consumers and audit hooks. */
    metadata?: Record<string, unknown>;
}
/**
 * A file attachment for an outbound email.
 */
export interface EmailAttachment {
    /** File name shown to the recipient. */
    filename: string;
    /** File contents as a Buffer or base64-encoded string. */
    content: Buffer | string;
    /** MIME type of the attachment (e.g. "application/pdf"). */
    contentType?: string;
}
/**
 * The result returned after attempting to send an email.
 * Uses a discriminated union so callers can branch cleanly on success/failure.
 */
export type SendEmailResult = {
    success: true;
    messageId: string;
} | {
    success: false;
    error: NotificationError;
} | {
    success: false;
    skipped: true;
    reason: string;
};
/**
 * Canonical error codes for notification-related failures.
 */
export declare enum NotificationErrorCode {
    MISSING_API_KEY = "NOTIFICATION_MISSING_API_KEY",
    SEND_DISABLED = "NOTIFICATION_SEND_DISABLED",
    PROVIDER_ERROR = "NOTIFICATION_PROVIDER_ERROR",
    INVALID_INPUT = "NOTIFICATION_INVALID_INPUT",
    TEMPLATE_NOT_FOUND = "NOTIFICATION_TEMPLATE_NOT_FOUND",
    UNKNOWN = "NOTIFICATION_UNKNOWN"
}
/**
 * A structured error returned by notification-core use cases.
 */
export interface NotificationError {
    code: NotificationErrorCode;
    message: string;
    /** Optional diagnostics for logging — never expose to end users. */
    details?: unknown;
}
/**
 * Helper to construct a typed NotificationError.
 */
export declare function createNotificationError(code: NotificationErrorCode, message: string, details?: unknown): NotificationError;
//# sourceMappingURL=types.d.ts.map