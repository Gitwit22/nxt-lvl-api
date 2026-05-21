ALTER TABLE "TimeflowSettings"
ADD COLUMN IF NOT EXISTS "payPeriodFrequency" TEXT NOT NULL DEFAULT 'monthly',
ADD COLUMN IF NOT EXISTS "payPeriodStartDate" TEXT;
