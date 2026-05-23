-- AddColumn timeType and leaveType to TimeflowTimeEntry
-- This migration adds first-class time entry categorization and backfills existing entries based on keyword inference

-- Add new columns
ALTER TABLE "TimeflowTimeEntry" ADD COLUMN "timeType" TEXT NOT NULL DEFAULT 'worked';
ALTER TABLE "TimeflowTimeEntry" ADD COLUMN "leaveType" TEXT;

-- Backfill logic: Infer timeType and leaveType from existing notes field
-- Pattern: if notes contain keywords, mark as leave entry with specific leave type; otherwise mark as worked
UPDATE "TimeflowTimeEntry" 
SET 
  "timeType" = CASE
    -- Keywords for leave detection
    WHEN "notes" ~* '\b(pto|time.?off|paid.?time.?off)\b' THEN 'leave'
    WHEN "notes" ~* '\b(vacation|vaca|vac)\b' THEN 'leave'
    WHEN "notes" ~* '\b(sick|sick.?day|sick.?leave)\b' THEN 'leave'
    WHEN "notes" ~* '\b(holiday|day.?off)\b' THEN 'leave'
    WHEN "notes" ~* '\b(bereavement|funeral.?leave)\b' THEN 'leave'
    WHEN "notes" ~* '\b(admin.?leave|admin|administrative.?leave)\b' THEN 'leave'
    WHEN "notes" ~* '\b(unpaid|unpaid.?leave|unpaid.?time)\b' THEN 'leave'
    -- If no client/project (manual entry logic)
    WHEN "clientId" IS NULL THEN 'manual'
    ELSE 'worked'
  END,
  "leaveType" = CASE
    WHEN "notes" ~* '\b(pto|time.?off|paid.?time.?off)\b' THEN 'pto'
    WHEN "notes" ~* '\b(vacation|vaca|vac)\b' THEN 'vacation'
    WHEN "notes" ~* '\b(sick|sick.?day|sick.?leave)\b' THEN 'sick'
    WHEN "notes" ~* '\b(holiday|day.?off)\b' THEN 'holiday'
    WHEN "notes" ~* '\b(bereavement|funeral.?leave)\b' THEN 'bereavement'
    WHEN "notes" ~* '\b(admin.?leave|admin|administrative.?leave)\b' THEN 'admin_leave'
    WHEN "notes" ~* '\b(unpaid|unpaid.?leave|unpaid.?time)\b' THEN 'unpaid'
    ELSE NULL
  END;

-- Create indexes for the new columns
CREATE INDEX "TimeflowTimeEntry_organizationId_userId_timeType_idx" 
  ON "TimeflowTimeEntry"("organizationId", "userId", "timeType");

CREATE INDEX "TimeflowTimeEntry_organizationId_userId_leaveType_idx" 
  ON "TimeflowTimeEntry"("organizationId", "userId", "leaveType");

-- Add constraint: leaveType can only be set when timeType is 'leave'
ALTER TABLE "TimeflowTimeEntry" 
ADD CONSTRAINT "leave_type_only_when_leave" 
CHECK (CASE WHEN "timeType" = 'leave' THEN "leaveType" IS NOT NULL ELSE "leaveType" IS NULL END);
