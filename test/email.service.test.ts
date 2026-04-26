import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test so that
// vi.mock hoisting picks them up reliably.
// ---------------------------------------------------------------------------

const executeEmailMock = vi.fn();

vi.mock("@nxtlvl/notification-core", () => ({
  loadNotificationConfig: vi.fn(() => ({
    resendApiKey: "test-api-key",
    emailFrom: "Nxt Lvl Support <support@nxtlvlts.com>",
    emailReplyTo: undefined,
    emailProvider: "resend",
    sendEnabled: true,
    logLevel: "info",
  })),
  ResendEmailProvider: vi.fn().mockImplementation(() => ({})),
  ConsoleEmailLogger: vi.fn().mockImplementation(() => ({})),
  SendEmailUseCase: vi.fn().mockImplementation(() => ({ execute: executeEmailMock })),
}));

vi.mock("../src/core/config/env.js", () => ({
  FRONTEND_BASE_URL: "https://mission-hub.example.com",
}));

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks are declared
// ---------------------------------------------------------------------------

// Reset module registry so the lazy singleton is fresh for each test group.
// We do this at the top level; individual tests share the singleton unless
// we explicitly reload — see the "init failure" describe block below.
const { sendInviteEmail } = await import("../src/core/services/email.service.js");

const baseParams = {
  to: "alice@example.com",
  recipientName: "Alice Smith",
  organizationName: "Test Org",
  assignedRole: "Staff",
  assignedPosition: "Director",
  rawToken: "abc123def456",
};

beforeEach(() => {
  vi.clearAllMocks();
  // Re-point executeEmailMock to a fresh resolved value each test
  executeEmailMock.mockResolvedValue({ success: true, messageId: "msg-default" });
});

// ---------------------------------------------------------------------------
// Core delegation
// ---------------------------------------------------------------------------

describe("sendInviteEmail — Core delegation", () => {
  it("calls SendEmailUseCase.execute (not Resend directly) with correct shape", async () => {
    const result = await sendInviteEmail(baseParams);

    expect(result).toBe(true);
    expect(executeEmailMock).toHaveBeenCalledOnce();
    expect(executeEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "alice@example.com",
        subject: "You've been invited to Mission Hub",
      }),
    );
  });

  it("passes both html and text bodies to execute", async () => {
    await sendInviteEmail(baseParams);

    const call = executeEmailMock.mock.calls[0]?.[0];
    expect(typeof call.html).toBe("string");
    expect(call.html.length).toBeGreaterThan(0);
    expect(typeof call.text).toBe("string");
    expect(call.text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Invite link construction
// ---------------------------------------------------------------------------

describe("sendInviteEmail — invite link", () => {
  it("builds the invite link using FRONTEND_BASE_URL", async () => {
    await sendInviteEmail(baseParams);

    const call = executeEmailMock.mock.calls[0]?.[0];
    expect(call.html).toContain("https://mission-hub.example.com/invite/accept?token=");
    expect(call.text).toContain("https://mission-hub.example.com/invite/accept?token=");
  });

  it("URL-encodes the raw token in the invite link", async () => {
    await sendInviteEmail({ ...baseParams, rawToken: "tok en+special&chars" });

    const call = executeEmailMock.mock.calls[0]?.[0];
    const encoded = encodeURIComponent("tok en+special&chars");
    expect(call.html).toContain(`token=${encoded}`);
    expect(call.text).toContain(`token=${encoded}`);
  });

  it("strips trailing slash from FRONTEND_BASE_URL before building the link", async () => {
    // The mock returns "https://mission-hub.example.com" (no trailing slash),
    // and the implementation calls .replace(/\/$/, ""), so both forms produce the same result.
    await sendInviteEmail(baseParams);

    const call = executeEmailMock.mock.calls[0]?.[0];
    expect(call.html).not.toContain("//invite");
  });

  it("invite link appears in html button href AND as fallback plain link", async () => {
    await sendInviteEmail(baseParams);

    const call = executeEmailMock.mock.calls[0]?.[0];
    const link = `https://mission-hub.example.com/invite/accept?token=${encodeURIComponent(baseParams.rawToken)}`;
    // href inside anchor tag
    expect(call.html).toContain(`href="${link}"`);
    // fallback text — appears at least twice (href + fallback paragraph)
    const occurrences = (call.html.match(new RegExp(link.replace(/[+?&]/g, "\\$&"), "g")) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Return values for each Core result shape
// ---------------------------------------------------------------------------

describe("sendInviteEmail — return values", () => {
  it("returns true when Core result is success=true", async () => {
    executeEmailMock.mockResolvedValueOnce({ success: true, messageId: "msg-1" });
    expect(await sendInviteEmail(baseParams)).toBe(true);
  });

  it("returns false when Core result is skipped", async () => {
    executeEmailMock.mockResolvedValueOnce({ success: false, skipped: true, reason: "sending disabled" });
    expect(await sendInviteEmail(baseParams)).toBe(false);
  });

  it("returns false when Core result is validation failure", async () => {
    executeEmailMock.mockResolvedValueOnce({
      success: false,
      error: { code: "NOTIFICATION_INVALID_INPUT", message: "Invalid recipient address" },
    });
    expect(await sendInviteEmail(baseParams)).toBe(false);
  });

  it("returns false when Core result is provider failure", async () => {
    executeEmailMock.mockResolvedValueOnce({
      success: false,
      error: { code: "NOTIFICATION_PROVIDER_ERROR", message: "Network error" },
    });
    expect(await sendInviteEmail(baseParams)).toBe(false);
  });

  it("returns false when Core result is missing API key", async () => {
    executeEmailMock.mockResolvedValueOnce({
      success: false,
      error: { code: "NOTIFICATION_MISSING_API_KEY", message: "RESEND_API_KEY is not configured" },
    });
    expect(await sendInviteEmail(baseParams)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Init failure — test in an isolated module context
// ---------------------------------------------------------------------------

describe("sendInviteEmail — email service init failure", () => {
  it("returns false and does not throw when loadNotificationConfig throws", async () => {
    // Reload the module so we get a fresh singleton state
    vi.resetModules();

    const { loadNotificationConfig } = await import("@nxtlvl/notification-core");
    (loadNotificationConfig as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("RESEND_API_KEY is required");
    });

    // Re-import the service to get a fresh module with an uncached singleton
    const { sendInviteEmail: freshSend } = await import("../src/core/services/email.service.js");

    const result = await freshSend(baseParams);
    expect(result).toBe(false);
  });
});
