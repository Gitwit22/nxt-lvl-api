"use strict";
/**
 * notification-core/domain/validation.ts
 *
 * Basic email address validation utilities.
 * These checks are intentionally lightweight — they catch obviously malformed
 * addresses without introducing complex regex or external libraries.
 * Deep RFC-5321 validation is delegated to the email provider (Resend).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidEmailAddress = isValidEmailAddress;
exports.validateSendEmailInput = validateSendEmailInput;
const types_js_1 = require("./types.js");
// ---------------------------------------------------------------------------
// Single-address validation
// ---------------------------------------------------------------------------
/**
 * Returns true when `value` looks like a plausible email address:
 *  - Has exactly one "@" sign
 *  - Local part (before @) is non-empty
 *  - Domain part (after @) contains at least one "." and non-empty segments
 *
 * Deliberately permissive — edge cases are caught by the Resend API.
 */
function isValidEmailAddress(value) {
    const atIndex = value.indexOf('@');
    if (atIndex <= 0)
        return false; // no "@" or "@" at position 0
    if (atIndex !== value.lastIndexOf('@'))
        return false; // multiple "@"
    const domain = value.slice(atIndex + 1);
    if (!domain)
        return false;
    const dotIndex = domain.lastIndexOf('.');
    if (dotIndex <= 0)
        return false; // no "." or "." at start of domain
    if (dotIndex === domain.length - 1)
        return false; // trailing "."
    return true;
}
// ---------------------------------------------------------------------------
// Address normalisation helper
// ---------------------------------------------------------------------------
function extractEmail(address) {
    return typeof address === 'string' ? address : address.email;
}
function toArray(value) {
    return Array.isArray(value) ? value : [value];
}
// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------
/**
 * Validates the recipient fields (`to`, `cc`, `bcc`) of a `SendEmailInput`.
 *
 * Returns `undefined` when all addresses are valid, or a `NotificationError`
 * with code `INVALID_INPUT` describing the first invalid address found.
 */
function validateSendEmailInput(input) {
    const fieldsToCheck = [
        { field: 'to', value: input.to },
        { field: 'cc', value: input.cc },
        { field: 'bcc', value: input.bcc },
    ];
    for (const { field, value } of fieldsToCheck) {
        if (value === undefined)
            continue;
        for (const address of toArray(value)) {
            const email = extractEmail(address);
            if (!isValidEmailAddress(email)) {
                return (0, types_js_1.createNotificationError)(types_js_1.NotificationErrorCode.INVALID_INPUT, `Invalid email address in "${field}": "${email}"`, { field, value: email });
            }
        }
    }
    if (!input.html && !input.text) {
        return (0, types_js_1.createNotificationError)(types_js_1.NotificationErrorCode.INVALID_INPUT, 'At least one of "html" or "text" must be provided.');
    }
    return undefined;
}
//# sourceMappingURL=validation.js.map