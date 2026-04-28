/**
 * notification-core/domain/validation.ts
 *
 * Basic email address validation utilities.
 * These checks are intentionally lightweight — they catch obviously malformed
 * addresses without introducing complex regex or external libraries.
 * Deep RFC-5321 validation is delegated to the email provider (Resend).
 */
import { type NotificationError, type SendEmailInput } from './types.js';
/**
 * Returns true when `value` looks like a plausible email address:
 *  - Has exactly one "@" sign
 *  - Local part (before @) is non-empty
 *  - Domain part (after @) contains at least one "." and non-empty segments
 *
 * Deliberately permissive — edge cases are caught by the Resend API.
 */
export declare function isValidEmailAddress(value: string): boolean;
/**
 * Validates the recipient fields (`to`, `cc`, `bcc`) of a `SendEmailInput`.
 *
 * Returns `undefined` when all addresses are valid, or a `NotificationError`
 * with code `INVALID_INPUT` describing the first invalid address found.
 */
export declare function validateSendEmailInput(input: SendEmailInput): NotificationError | undefined;
//# sourceMappingURL=validation.d.ts.map