/**
 * Audit Logging Service for Tax ID Operations
 *
 * Logs all sensitive operations on tax identifiers including:
 * - Creation and updates
 * - Access/reveal events
 * - Deletion
 * - Status changes
 *
 * Important: Raw tax IDs are NEVER logged
 */

import { prisma } from "../db/prisma.js";

export type AuditAction =
  | "tax_id_created"
  | "tax_id_updated"
  | "tax_id_revealed"
  | "tax_id_deleted"
  | "tax_id_verification_status_changed"
  | "tax_id_revealed_for_export";

/**
 * Log a tax ID audit event
 */
export async function logAuditEvent(
  organizationId: string,
  payeeId: string,
  action: AuditAction,
  userId: string,
  userEmail: string | undefined,
  details?: Record<string, unknown>,
  ipAddress?: string,
  userAgent?: string
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        organizationId,
        payeeId,
        action,
        actionType: action.includes("created")
          ? "CREATE"
          : action.includes("updated")
            ? "UPDATE"
            : action.includes("deleted")
              ? "DELETE"
              : "READ",
        userId,
        userEmail,
        details: details ? JSON.stringify(details) : null,
        ipAddress,
        userAgent,
      },
    });
  } catch (error) {
    console.error(
      `Failed to log audit event for ${action}:`,
      error instanceof Error ? error.message : "Unknown error"
    );
    // Don't throw - audit failures shouldn't break the operation
    // but should be logged to application logs
  }
}

/**
 * Get audit log for a payee's tax ID
 */
export async function getPayeeAuditLog(
  organizationId: string,
  payeeId: string,
  limit: number = 50
) {
  try {
    const logs = await prisma.auditLog.findMany({
      where: {
        organizationId,
        payeeId,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: limit,
    });

    return logs.map((log) => ({
      ...log,
      details: log.details ? JSON.parse(log.details as string) : undefined,
    }));
  } catch (error) {
    console.error(
      "Failed to retrieve audit logs:",
      error instanceof Error ? error.message : "Unknown error"
    );
    return [];
  }
}

/**
 * Check if a user has performed too many reveal operations (rate limiting)
 */
export async function checkRevealRateLimit(
  userId: string,
  organizationId: string,
  windowMinutes: number = 60,
  maxReveals: number = 10
): Promise<boolean> {
  try {
    const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000);

    const count = await prisma.auditLog.count({
      where: {
        userId,
        organizationId,
        action: "tax_id_revealed",
        createdAt: {
          gte: windowStart,
        },
      },
    });

    return count < maxReveals;
  } catch (error) {
    console.error(
      "Failed to check reveal rate limit:",
      error instanceof Error ? error.message : "Unknown error"
    );
    // On error, allow the operation (fail open for availability)
    return true;
  }
}
