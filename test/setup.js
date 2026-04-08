/**
 * Shared test setup for server-side tests.
 * Mocking is done per-file with vi.mock().
 * Here we only set environment variables required by config.ts.
 */
import { vi } from "vitest";
// Deterministic JWT secret for tests
process.env.JWT_SECRET = "test-secret-for-vitest-do-not-use-in-prod";
process.env.NODE_ENV = "test";
// Suppress logger output during tests
vi.mock("../src/logger.js", () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));
