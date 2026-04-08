/**
 * Canonical naming constants for the Community Chronicle program.
 *
 * Import from here instead of using literal strings so the product name,
 * system slug, and resource label are defined in exactly one place.
 */

/** Human-readable product name shown in UI, emails, and reports. */
export const PROGRAM_DISPLAY_NAME = "Community Chronicle";

/** Machine-readable slug used in IDs, routes, config keys, and database fields. */
export const PROGRAM_SYSTEM_NAME = "community-chronicle";

/** Default label for the primary resource managed by this program. */
export const PROGRAM_RESOURCE_LABEL = "documents";

/** Previous working names — kept only for backward-compatible look-ups. */
export const PROGRAM_ALIASES = ["Mission Hub", "Community Hub", "Document Vault", "Equity Research Vault"];
