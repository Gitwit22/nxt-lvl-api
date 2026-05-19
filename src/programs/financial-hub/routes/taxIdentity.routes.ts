/**
 * Tax Identity API Routes
 *
 * Secure endpoints for managing encrypted tax identifiers (SSN, EIN, etc.)
 *
 * POST   /api/payees/:payeeId/tax-identity         - Create or update tax identity
 * GET    /api/payees/:payeeId/tax-identity/masked  - Get masked display (any user with payee access)
 * POST   /api/payees/:payeeId/tax-identity/reveal  - Reveal full tax ID (finance_admin only)
 * DELETE /api/payees/:payeeId/tax-identity         - Delete tax identity (finance_admin only)
 * GET    /api/payees/:payeeId/tax-identity/audit   - Get audit log (finance_admin only)
 */

import express, { type Request, type Response, type NextFunction } from "express";
import { prisma } from "../../../core/db/prisma.js";
import {
  encryptTaxId,
  decryptTaxId,
  hashTaxId,
  formatTaxId,
  extractLast4Digits,
  validateEncryptionConfiguration,
  maskTaxId,
} from "../../../core/services/taxIdEncryption.js";
import {
  logAuditEvent,
  checkRevealRateLimit,
  getPayeeAuditLog,
} from "../../../core/services/auditLogging.js";
import { logger } from "../../../logger.js";

const router = express.Router();

/**
 * Middleware: Check encryption configuration
 */
export function checkTaxIdEncryptionMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const config = validateEncryptionConfiguration();
  if (!config.valid) {
    logger.error("Tax ID encryption misconfigured:", config.error);
    res.status(503).json({
      error: "Tax ID operations are not available due to configuration issues",
      code: "TAX_ID_ENCRYPTION_DISABLED",
    });
    return;
  }
  next();
}

/**
 * Middleware: Check if user has finance_admin role
 */
async function requireFinanceAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // TODO: Implement role checking based on your auth system
  // For now, assume user context is available in req.user
  const userRole = (req as any).userRole || "unknown";

  if (
    userRole !== "finance_admin" &&
    userRole !== "org_owner" &&
    userRole !== "owner_admin"
  ) {
    res.status(403).json({
      error: "Insufficient permissions to access this resource",
      code: "FORBIDDEN",
      required: "finance_admin or org_owner",
    });
    return;
  }

  next();
}

/**
 * POST /api/payees/:payeeId/tax-identity
 * Create or update tax identity for a payee
 *
 * Body:
 * {
 *   "taxIdType": "SSN" | "EIN" | "ITIN",
 *   "taxId": "123-45-6789",
 *   "taxIdStatus": "Collected" | "Verified" | "Needs correction"
 * }
 */
router.post(
  "/payees/:payeeId/tax-identity",
  checkTaxIdEncryptionMiddleware,
  requireFinanceAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { payeeId } = req.params;
      const { taxIdType, taxId, taxIdStatus } = req.body;
      const organizationId = (req as any).organizationId || "default-org";
      const userId = (req as any).userId || "system";
      const userEmail = (req as any).userEmail;

      // Validate inputs
      if (!taxIdType || !["SSN", "EIN", "ITIN"].includes(taxIdType)) {
        res.status(400).json({
          error: "Invalid taxIdType: must be SSN, EIN, or ITIN",
        });
        return;
      }

      if (!taxId) {
        res.status(400).json({
          error: "taxId is required",
        });
        return;
      }

      // Verify payee exists
      const payee = await prisma.payee.findUnique({
        where: { id: payeeId },
      });

      if (!payee) {
        res.status(404).json({
          error: "Payee not found",
          code: "PAYEE_NOT_FOUND",
        });
        return;
      }

      // Format and validate tax ID
      let formattedTaxId: string;
      try {
        formattedTaxId = formatTaxId(taxId);
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : "Invalid tax ID format",
        });
        return;
      }

      // Extract last 4 and generate hash
      const last4 = extractLast4Digits(formattedTaxId);
      const taxIdHash = hashTaxId(formattedTaxId);

      // Encrypt the tax ID
      let encryptedTaxId: string;
      try {
        encryptedTaxId = encryptTaxId(formattedTaxId);
      } catch (error) {
        logger.error("Failed to encrypt tax ID:", error);
        res.status(500).json({
          error: "Failed to securely process tax ID",
          code: "ENCRYPTION_FAILED",
        });
        return;
      }

      // Check for duplicate using hash (without exposing raw value)
      const existingTaxId = await prisma.payeeSecureTaxIdentity.findFirst({
        where: {
          organizationId,
          taxIdHash,
          payeeId: { not: payeeId }, // Exclude current payee
        },
      });

      if (existingTaxId) {
        res.status(409).json({
          error: "This tax ID is already associated with another payee",
          code: "TAX_ID_DUPLICATE",
        });
        return;
      }

      // Create or update secure tax identity
      const secureTaxIdentity = await prisma.payeeSecureTaxIdentity.upsert({
        where: { payeeId },
        create: {
          organizationId,
          payeeId,
          taxIdType: taxIdType as "SSN" | "EIN" | "ITIN",
          encryptedTaxId,
          taxIdLast4: last4,
          taxIdHash,
          taxIdStatus: taxIdStatus || "Collected",
          createdByUserId: userId,
          updatedByUserId: userId,
        },
        update: {
          encryptedTaxId,
          taxIdLast4: last4,
          taxIdHash,
          taxIdStatus: taxIdStatus || "Collected",
          updatedByUserId: userId,
          updatedAt: new Date(),
        },
      });

      // Update payee record
      await prisma.payee.update({
        where: { id: payeeId },
        data: {
          hasTaxIdentity: true,
          taxIdStatus: taxIdStatus || "Collected",
          updatedByUserId: userId,
        },
      });

      // Log audit event
      await logAuditEvent(
        organizationId,
        payeeId,
        existingTaxId ? "tax_id_updated" : "tax_id_created",
        userId,
        userEmail,
        {
          taxIdType,
          last4,
          status: taxIdStatus,
        }
      );

      // Return masked response
      res.json({
        success: true,
        payeeId,
        taxIdType,
        taxIdLast4: last4,
        taxIdStatus: secureTaxIdentity.taxIdStatus,
        masked: maskTaxId(last4, taxIdType as "SSN" | "EIN"),
      });
    } catch (error) {
      logger.error("Error creating/updating tax identity:", error);
      res.status(500).json({
        error: "Failed to process tax identity",
        code: "INTERNAL_ERROR",
      });
    }
  }
);

/**
 * GET /api/payees/:payeeId/tax-identity/masked
 * Get masked tax identity display (anyone with payee access)
 */
router.get(
  "/payees/:payeeId/tax-identity/masked",
  checkTaxIdEncryptionMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { payeeId } = req.params;
      const organizationId = (req as any).organizationId || "default-org";

      // Verify payee exists
      const payee = await prisma.payee.findUnique({
        where: { id: payeeId },
      });

      if (!payee) {
        res.status(404).json({
          error: "Payee not found",
          code: "PAYEE_NOT_FOUND",
        });
        return;
      }

      // Get secure tax identity
      const taxIdentity = await prisma.payeeSecureTaxIdentity.findUnique({
        where: { payeeId },
      });

      if (!taxIdentity) {
        res.json({
          payeeId,
          hasTaxIdentity: false,
          taxIdType: null,
          taxIdLast4: null,
          masked: null,
        });
        return;
      }

      res.json({
        payeeId,
        hasTaxIdentity: true,
        taxIdType: taxIdentity.taxIdType,
        taxIdLast4: taxIdentity.taxIdLast4,
        taxIdStatus: taxIdentity.taxIdStatus,
        masked: maskTaxId(
          taxIdentity.taxIdLast4,
          taxIdentity.taxIdType as "SSN" | "EIN"
        ),
        taxIdVerifiedAt: taxIdentity.taxIdVerifiedAt,
      });
    } catch (error) {
      logger.error("Error retrieving masked tax identity:", error);
      res.status(500).json({
        error: "Failed to retrieve tax identity",
        code: "INTERNAL_ERROR",
      });
    }
  }
);

/**
 * POST /api/payees/:payeeId/tax-identity/reveal
 * Reveal full tax ID (finance_admin only, requires rate limiting and audit logging)
 */
router.post(
  "/payees/:payeeId/tax-identity/reveal",
  checkTaxIdEncryptionMiddleware,
  requireFinanceAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { payeeId } = req.params;
      const organizationId = (req as any).organizationId || "default-org";
      const userId = (req as any).userId || "system";
      const userEmail = (req as any).userEmail;
      const ipAddress = req.ip;
      const userAgent = req.get("user-agent");

      // Check rate limit
      const withinLimit = await checkRevealRateLimit(userId, organizationId);
      if (!withinLimit) {
        res.status(429).json({
          error: "Too many reveal requests. Please try again later.",
          code: "RATE_LIMIT_EXCEEDED",
        });
        return;
      }

      // Get secure tax identity
      const taxIdentity = await prisma.payeeSecureTaxIdentity.findUnique({
        where: { payeeId },
      });

      if (!taxIdentity) {
        res.status(404).json({
          error: "No tax identity found for this payee",
          code: "TAX_ID_NOT_FOUND",
        });
        return;
      }

      // Decrypt tax ID
      let decrypted: string;
      try {
        decrypted = decryptTaxId(taxIdentity.encryptedTaxId);
      } catch (error) {
        logger.error("Failed to decrypt tax ID:", error);
        res.status(500).json({
          error: "Failed to decrypt tax ID",
          code: "DECRYPTION_FAILED",
        });
        return;
      }

      // Log the reveal event
      await logAuditEvent(
        organizationId,
        payeeId,
        "tax_id_revealed",
        userId,
        userEmail,
        {
          reason: req.body?.reason || "No reason provided",
          last4: taxIdentity.taxIdLast4,
        },
        ipAddress,
        userAgent
      );

      // Return decrypted value (only in this response, never cached)
      res.json({
        payeeId,
        taxIdType: taxIdentity.taxIdType,
        taxId: decrypted,
        last4: taxIdentity.taxIdLast4,
        status: taxIdentity.taxIdStatus,
        warning:
          "This decrypted value is only valid for this request. Do not share or store it. Revelation logged for audit.",
      });
    } catch (error) {
      logger.error("Error revealing tax identity:", error);
      res.status(500).json({
        error: "Failed to reveal tax identity",
        code: "INTERNAL_ERROR",
      });
    }
  }
);

/**
 * DELETE /api/payees/:payeeId/tax-identity
 * Delete tax identity (finance_admin only)
 */
router.delete(
  "/payees/:payeeId/tax-identity",
  checkTaxIdEncryptionMiddleware,
  requireFinanceAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { payeeId } = req.params;
      const organizationId = (req as any).organizationId || "default-org";
      const userId = (req as any).userId || "system";
      const userEmail = (req as any).userEmail;

      // Delete secure tax identity
      const deleted = await prisma.payeeSecureTaxIdentity.delete({
        where: { payeeId },
      });

      // Update payee record
      await prisma.payee.update({
        where: { id: payeeId },
        data: {
          hasTaxIdentity: false,
          taxIdStatus: "Missing",
          updatedByUserId: userId,
        },
      });

      // Log audit event
      await logAuditEvent(
        organizationId,
        payeeId,
        "tax_id_deleted",
        userId,
        userEmail,
        {
          reason: req.body?.reason || "No reason provided",
          last4: deleted.taxIdLast4,
        }
      );

      res.json({
        success: true,
        payeeId,
        message: "Tax identity deleted",
      });
    } catch (error) {
      logger.error("Error deleting tax identity:", error);
      res.status(500).json({
        error: "Failed to delete tax identity",
        code: "INTERNAL_ERROR",
      });
    }
  }
);

/**
 * GET /api/payees/:payeeId/tax-identity/audit
 * Get audit log for tax identity operations (finance_admin only)
 */
router.get(
  "/payees/:payeeId/tax-identity/audit",
  checkTaxIdEncryptionMiddleware,
  requireFinanceAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { payeeId } = req.params;
      const organizationId = (req as any).organizationId || "default-org";
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

      const logs = await getPayeeAuditLog(organizationId, payeeId, limit);

      res.json({
        payeeId,
        count: logs.length,
        logs,
      });
    } catch (error) {
      logger.error("Error retrieving audit log:", error);
      res.status(500).json({
        error: "Failed to retrieve audit log",
        code: "INTERNAL_ERROR",
      });
    }
  }
);

export { router as taxIdentityRouter };
