-- Improve event-scoped report/payment read performance for dashboard loads.
CREATE INDEX IF NOT EXISTS eventure_payment_org_event_updated_idx
  ON "EventurePayment" ("organizationId", "eventId", "updatedAt");

CREATE INDEX IF NOT EXISTS eventure_payment_org_event_status_updated_idx
  ON "EventurePayment" ("organizationId", "eventId", "paymentStatus", "updatedAt");

CREATE INDEX IF NOT EXISTS eventure_payment_tx_org_event_transaction_at_idx
  ON "EventurePaymentTransaction" ("organizationId", "eventId", "transactionAt");

CREATE INDEX IF NOT EXISTS eventure_payment_tx_org_event_status_transaction_at_idx
  ON "EventurePaymentTransaction" ("organizationId", "eventId", "status", "transactionAt");
