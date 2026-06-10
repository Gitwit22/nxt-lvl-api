import { EventureServiceError } from "./eventure-error.js";

const ELIGIBLE_COMPANY_STATUSES = new Set(["active", "pending"]);
const ELIGIBLE_PAYMENT_STATUSES = new Set(["confirmed", "paid", "comped", "payment confirmed"]);

export function normalizeEligibilityStatus(value?: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

export function isEligibleCompanyStatus(value?: string | null): boolean {
  return ELIGIBLE_COMPANY_STATUSES.has(normalizeEligibilityStatus(value));
}

export function isEligiblePaymentStatus(value?: string | null): boolean {
  return ELIGIBLE_PAYMENT_STATUSES.has(normalizeEligibilityStatus(value));
}

export function assertEligibleCompanyStatus(value: string | null | undefined): void {
  if (isEligibleCompanyStatus(value)) return;
  throw new EventureServiceError(
    "Company status is not eligible for participant conversion. Allowed statuses: active, pending.",
    400,
  );
}

export function assertEligiblePaymentStatus(value: string | null | undefined): void {
  if (isEligiblePaymentStatus(value)) return;
  throw new EventureServiceError(
    "A confirmed/paid payment is required before creating a participant.",
    400,
  );
}
