CREATE TABLE IF NOT EXISTS "TimeflowExpense" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "category" TEXT NOT NULL DEFAULT 'other',
  "billableToClient" BOOLEAN NOT NULL DEFAULT true,
  "billTo" TEXT NOT NULL DEFAULT 'client',
  "clientId" TEXT,
  "date" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "excludedFromPayPeriod" BOOLEAN NOT NULL DEFAULT false,
  "includedInPayPeriod" BOOLEAN NOT NULL DEFAULT false,
  "invoiceId" TEXT,
  "notes" TEXT NOT NULL DEFAULT '',
  "projectId" TEXT,
  "receiptAttached" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'billable',
  "vendor" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TimeflowExpense_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TimeflowExpense_organizationId_userId_idx"
  ON "TimeflowExpense" ("organizationId", "userId");

CREATE INDEX IF NOT EXISTS "TimeflowExpense_organizationId_userId_clientId_idx"
  ON "TimeflowExpense" ("organizationId", "userId", "clientId");

CREATE INDEX IF NOT EXISTS "TimeflowExpense_organizationId_userId_projectId_idx"
  ON "TimeflowExpense" ("organizationId", "userId", "projectId");

CREATE INDEX IF NOT EXISTS "TimeflowExpense_organizationId_userId_invoiceId_idx"
  ON "TimeflowExpense" ("organizationId", "userId", "invoiceId");

CREATE INDEX IF NOT EXISTS "TimeflowExpense_organizationId_userId_date_idx"
  ON "TimeflowExpense" ("organizationId", "userId", "date");

CREATE INDEX IF NOT EXISTS "TimeflowExpense_organizationId_userId_status_idx"
  ON "TimeflowExpense" ("organizationId", "userId", "status");
