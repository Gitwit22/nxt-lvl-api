import { describe, expect, it } from "vitest";

// isPaidStatus is a pure helper with no prisma dependency — import without mocking
const { isPaidStatus } = await import("../src/programs/eventure/services/attendee-import.service.js");

describe("isPaidStatus", () => {
  it("returns true for 'paid'", () => {
    expect(isPaidStatus("paid")).toBe(true);
  });

  it("returns true for 'Paid' (case-insensitive)", () => {
    expect(isPaidStatus("Paid")).toBe(true);
  });

  it("returns true for 'PAID' (uppercase)", () => {
    expect(isPaidStatus("PAID")).toBe(true);
  });

  it("returns true for 'comped'", () => {
    expect(isPaidStatus("comped")).toBe(true);
  });

  it("returns true for 'Comped' (case-insensitive)", () => {
    expect(isPaidStatus("Comped")).toBe(true);
  });

  it("returns true for 'payment confirmed'", () => {
    expect(isPaidStatus("payment confirmed")).toBe(true);
  });

  it("returns true for 'Payment Confirmed' (case-insensitive)", () => {
    expect(isPaidStatus("Payment Confirmed")).toBe(true);
  });

  it("returns true when value has surrounding whitespace", () => {
    expect(isPaidStatus("  paid  ")).toBe(true);
  });

  it("returns false for 'pending'", () => {
    expect(isPaidStatus("pending")).toBe(false);
  });

  it("returns false for 'confirmed' alone (RSVP confirm, not financial)", () => {
    expect(isPaidStatus("confirmed")).toBe(false);
  });

  it("returns false for 'invoiced'", () => {
    expect(isPaidStatus("invoiced")).toBe(false);
  });

  it("returns false for 'unpaid'", () => {
    expect(isPaidStatus("unpaid")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isPaidStatus("")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isPaidStatus(undefined)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isPaidStatus(null)).toBe(false);
  });

  it("returns false for whitespace-only string", () => {
    expect(isPaidStatus("   ")).toBe(false);
  });
});
