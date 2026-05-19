/**
 * Secure Tax ID Encryption Service
 *
 * Handles encryption/decryption of Social Security Numbers (SSN), 
 * Employer Identification Numbers (EIN), and other tax identifiers.
 *
 * Security principles:
 * - All encryption happens on the backend only
 * - Encryption key is environment-variable only (never in code)
 * - No raw values logged or exposed
 * - Hashing for duplicate detection without exposing values
 * - Only last 4 digits stored in plain text for display
 */

import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const SALT_LENGTH = 16; // 128 bits
const IV_LENGTH = 16; // 128 bits for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits
const ENCODING = "hex";

/**
 * Get encryption key from environment variable
 * @throws Error if TAX_ID_ENCRYPTION_KEY is not set
 */
export function getEncryptionKey(): Buffer {
  const keyEnv = process.env.TAX_ID_ENCRYPTION_KEY;
  if (!keyEnv) {
    throw new Error(
      "TAX_ID_ENCRYPTION_KEY environment variable is not set. Tax ID operations are disabled."
    );
  }
  // Key should be 32 bytes for AES-256 (64 hex characters)
  if (keyEnv.length !== 64) {
    throw new Error(
      "TAX_ID_ENCRYPTION_KEY must be 64 hex characters (32 bytes) for AES-256"
    );
  }
  try {
    return Buffer.from(keyEnv, "hex");
  } catch (error) {
    throw new Error("TAX_ID_ENCRYPTION_KEY must be valid hex format");
  }
}

/**
 * Validate that encryption is properly configured
 * Should be called on app startup
 */
export function validateEncryptionConfiguration(): {
  valid: boolean;
  error?: string;
} {
  try {
    const key = getEncryptionKey();
    if (process.env.NODE_ENV === "production") {
      // In production, ensure key is not a default/demo key
      // A real implementation would check against known demo keys
      if (
        key.toString("hex") ===
        "0000000000000000000000000000000000000000000000000000000000000000"
      ) {
        return {
          valid: false,
          error: "Production cannot use default/demo encryption key",
        };
      }
    }
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to validate encryption configuration",
    };
  }
}

/**
 * Format a tax ID (SSN or EIN) for storage
 * Accepts both formatted (###-##-####) and unformatted (##########) input
 * Returns formatted version (###-##-#### for SSN, ##-####### for EIN)
 */
export function formatTaxId(value: string): string {
  const digits = value.replace(/\D/g, "");

  if (digits.length === 9) {
    // SSN: ###-##-####
    return `${digits.substring(0, 3)}-${digits.substring(3, 5)}-${digits.substring(
      5,
      9
    )}`;
  } else if (digits.length === 9) {
    // EIN: ##-#######
    return `${digits.substring(0, 2)}-${digits.substring(2, 9)}`;
  }

  throw new Error(
    `Invalid tax ID format: expected 9 digits, got ${digits.length}`
  );
}

/**
 * Extract last 4 digits from a tax ID
 */
export function extractLast4Digits(taxId: string): string {
  const digits = taxId.replace(/\D/g, "");
  if (digits.length < 4) {
    throw new Error("Tax ID must have at least 4 digits");
  }
  return digits.substring(digits.length - 4);
}

/**
 * Generate a hash of the tax ID for duplicate detection
 * Uses SHA-256 to create a one-way hash that can be used to detect duplicates
 * without exposing the actual value
 */
export function hashTaxId(formattedTaxId: string): string {
  return crypto
    .createHash("sha256")
    .update(formattedTaxId)
    .digest("hex");
}

/**
 * Encrypt a tax ID
 * @param plainText The formatted tax ID (e.g., "123-45-6789")
 * @returns Encrypted data as hex string with embedded IV and auth tag
 */
export function encryptTaxId(plainText: string): string {
  try {
    const key = getEncryptionKey();

    // Generate random IV for this encryption
    const iv = crypto.randomBytes(IV_LENGTH);

    // Create cipher
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    // Encrypt the data
    let encrypted = cipher.update(plainText, "utf8", ENCODING);
    encrypted += cipher.final(ENCODING);

    // Get authentication tag
    const authTag = cipher.getAuthTag();

    // Combine IV + encrypted + authTag
    // Format: <iv_hex><authTag_hex><encrypted_hex>
    const combined = iv.toString(ENCODING) + authTag.toString(ENCODING) + encrypted;

    return combined;
  } catch (error) {
    throw new Error(
      `Failed to encrypt tax ID: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

/**
 * Decrypt a tax ID
 * @param encrypted The encrypted data as hex string (from encryptTaxId)
 * @returns Decrypted tax ID (e.g., "123-45-6789")
 */
export function decryptTaxId(encrypted: string): string {
  try {
    const key = getEncryptionKey();

    // Parse the combined data
    // Format: <iv_hex><authTag_hex><encrypted_hex>
    const ivHex = encrypted.substring(0, IV_LENGTH * 2); // Each byte is 2 hex chars
    const authTagHex = encrypted.substring(IV_LENGTH * 2, IV_LENGTH * 2 + AUTH_TAG_LENGTH * 2);
    const encryptedData = encrypted.substring(IV_LENGTH * 2 + AUTH_TAG_LENGTH * 2);

    const iv = Buffer.from(ivHex, ENCODING);
    const authTag = Buffer.from(authTagHex, ENCODING);

    // Create decipher
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    // Decrypt
    let decrypted = decipher.update(encryptedData, ENCODING, "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (error) {
    throw new Error(
      `Failed to decrypt tax ID: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

/**
 * Create a masked display string for a tax ID
 * @param last4 The last 4 digits
 * @param taxIdType The type of tax ID (SSN or EIN)
 * @returns Masked string (e.g., "***-**-1234" or "**-***1234")
 */
export function maskTaxId(last4: string, taxIdType: "SSN" | "EIN"): string {
  if (taxIdType === "SSN") {
    return `***-**-${last4}`;
  } else if (taxIdType === "EIN") {
    return `**-***${last4}`;
  }
  return `***${last4}`;
}
