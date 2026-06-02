-- Align EventureRegistration uniqueness with the new attendee import flow.
-- from Prisma schema: @@unique([eventId, attendeeId, registrationType])

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'EventureRegistration_eventId_attendeeId_key'
  ) THEN
    ALTER TABLE "EventureRegistration"
      DROP CONSTRAINT "EventureRegistration_eventId_attendeeId_key";
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'EventureRegistration_eventId_attendeeId_registrationType_key'
  ) THEN
    ALTER TABLE "EventureRegistration"
      ADD CONSTRAINT "EventureRegistration_eventId_attendeeId_registrationType_key"
      UNIQUE ("eventId", "attendeeId", "registrationType");
  END IF;
END$$;