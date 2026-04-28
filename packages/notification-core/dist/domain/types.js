"use strict";
/**
 * notification-core/domain/types.ts
 *
 * Core domain types for the notification-core module.
 * These are application-agnostic and must not reference any specific framework,
 * transport, or product. All concrete implementations live in infrastructure/.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationErrorCode = void 0;
exports.createNotificationError = createNotificationError;
// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
/**
 * Canonical error codes for notification-related failures.
 */
var NotificationErrorCode;
(function (NotificationErrorCode) {
    NotificationErrorCode["MISSING_API_KEY"] = "NOTIFICATION_MISSING_API_KEY";
    NotificationErrorCode["SEND_DISABLED"] = "NOTIFICATION_SEND_DISABLED";
    NotificationErrorCode["PROVIDER_ERROR"] = "NOTIFICATION_PROVIDER_ERROR";
    NotificationErrorCode["INVALID_INPUT"] = "NOTIFICATION_INVALID_INPUT";
    NotificationErrorCode["TEMPLATE_NOT_FOUND"] = "NOTIFICATION_TEMPLATE_NOT_FOUND";
    NotificationErrorCode["UNKNOWN"] = "NOTIFICATION_UNKNOWN";
})(NotificationErrorCode || (exports.NotificationErrorCode = NotificationErrorCode = {}));
/**
 * Helper to construct a typed NotificationError.
 */
function createNotificationError(code, message, details) {
    return { code, message, details };
}
//# sourceMappingURL=types.js.map