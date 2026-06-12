/**
 * Seeds the 13 price options for the 36th Annual Michigan Roundtable Golf Classic.
 *
 * Run: node scripts/seed-golf-classic-price-options.js
 *
 * Idempotent — uses upsert on (organizationId, eventId, code) unique key.
 * Looks up org by slug and uses the hardcoded event ID.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const ORG_SLUG = "michigan-roundtable";
const EVENT_ID = "cmptps0r50000ob21n6tiw3nk";

/** @type {Array<{code:string, name:string, category:string, flight:string|null, priceCents:number, includedFoursomes:number, includedGolfers:number, includedNonGolfers:number, includedAttendeeSlots:number, isLimited:boolean, participantEligible:boolean, sortOrder:number}>} */
const PRICE_OPTIONS = [
  {
    code: "TITLE_SPONSOR",
    name: "Michigan Roundtable Classic Title Sponsor",
    category: "SPONSORSHIP",
    flight: "PM",
    priceCents: 3_000_000,
    includedFoursomes: 3,
    includedGolfers: 12,
    includedNonGolfers: 6,
    includedAttendeeSlots: 18,
    isLimited: true,
    participantEligible: true,
    sortOrder: 1,
  },
  {
    code: "PM_PRESENTING_SPONSOR",
    name: "PM Flight Presenting Sponsor",
    category: "SPONSORSHIP",
    flight: "PM",
    priceCents: 2_000_000,
    includedFoursomes: 2,
    includedGolfers: 8,
    includedNonGolfers: 4,
    includedAttendeeSlots: 12,
    isLimited: true,
    participantEligible: true,
    sortOrder: 2,
  },
  {
    code: "JUSTICE_LOUNGE_SPONSOR",
    name: '19th Hole "Justice Lounge" Reception Sponsor',
    category: "SPONSORSHIP",
    flight: "PM",
    priceCents: 1_500_000,
    includedFoursomes: 1,
    includedGolfers: 4,
    includedNonGolfers: 2,
    includedAttendeeSlots: 6,
    isLimited: true,
    participantEligible: true,
    sortOrder: 3,
  },
  {
    code: "LUNCH_SPONSOR",
    name: "Lunch Sponsor",
    category: "SPONSORSHIP",
    flight: "PM",
    priceCents: 1_250_000,
    includedFoursomes: 1,
    includedGolfers: 4,
    includedNonGolfers: 2,
    includedAttendeeSlots: 6,
    isLimited: true,
    participantEligible: true,
    sortOrder: 4,
  },
  {
    code: "WELLNESS_LOUNGE_SPONSOR",
    name: "Wellness Lounge Sponsor",
    category: "SPONSORSHIP",
    flight: "PM",
    priceCents: 1_000_000,
    includedFoursomes: 2,
    includedGolfers: 8,
    includedNonGolfers: 0,
    includedAttendeeSlots: 8,
    isLimited: true,
    participantEligible: true,
    sortOrder: 5,
  },
  {
    code: "GOLF_GIFT_SPONSOR",
    name: "Golf Gift Sponsor",
    category: "SPONSORSHIP",
    flight: "PM",
    priceCents: 1_000_000,
    includedFoursomes: 1,
    includedGolfers: 4,
    includedNonGolfers: 0,
    includedAttendeeSlots: 4,
    isLimited: true,
    participantEligible: true,
    sortOrder: 6,
  },
  {
    code: "BEVERAGE_CART_SPONSOR",
    name: "Beverage Cart Sponsor",
    category: "SPONSORSHIP",
    flight: "PM",
    priceCents: 850_000,
    includedFoursomes: 1,
    includedGolfers: 4,
    includedNonGolfers: 0,
    includedAttendeeSlots: 4,
    isLimited: true,
    participantEligible: true,
    sortOrder: 7,
  },
  {
    code: "BREAKFAST_SPONSOR",
    name: "Breakfast Sponsor",
    category: "SPONSORSHIP",
    flight: "PM",
    priceCents: 800_000,
    includedFoursomes: 1,
    includedGolfers: 4,
    includedNonGolfers: 0,
    includedAttendeeSlots: 4,
    isLimited: true,
    participantEligible: true,
    sortOrder: 8,
  },
  {
    code: "HOLE_SPONSOR",
    name: "Hole Sponsor",
    category: "SPONSORSHIP",
    flight: null,
    priceCents: 250_000,
    includedFoursomes: 0,
    includedGolfers: 0,
    includedNonGolfers: 0,
    includedAttendeeSlots: 0,
    isLimited: false,
    participantEligible: false,
    sortOrder: 9,
  },
  {
    code: "AM_FOURSOME_DTE",
    name: "1 AM Flight Foursome – Presented by DTE",
    category: "FOURSOME",
    flight: "AM",
    priceCents: 400_000,
    includedFoursomes: 1,
    includedGolfers: 4,
    includedNonGolfers: 0,
    includedAttendeeSlots: 4,
    isLimited: false,
    participantEligible: true,
    sortOrder: 10,
  },
  {
    code: "AM_NON_GOLFER_DTE",
    name: "Non-Golfer AM Flight – Presented by DTE",
    category: "NON_GOLFER",
    flight: "AM",
    priceCents: 25_000,
    includedFoursomes: 0,
    includedGolfers: 0,
    includedNonGolfers: 1,
    includedAttendeeSlots: 1,
    isLimited: false,
    participantEligible: true,
    sortOrder: 11,
  },
  {
    code: "PM_FOURSOME",
    name: "1 PM Flight Foursome",
    category: "FOURSOME",
    flight: "PM",
    priceCents: 400_000,
    includedFoursomes: 1,
    includedGolfers: 4,
    includedNonGolfers: 0,
    includedAttendeeSlots: 4,
    isLimited: false,
    participantEligible: true,
    sortOrder: 20,
  },
  {
    code: "PM_NON_GOLFER",
    name: "Non-Golfer PM Flight",
    category: "NON_GOLFER",
    flight: "PM",
    priceCents: 25_000,
    includedFoursomes: 0,
    includedGolfers: 0,
    includedNonGolfers: 1,
    includedAttendeeSlots: 1,
    isLimited: false,
    participantEligible: true,
    sortOrder: 21,
  },
];

async function main() {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { slug: ORG_SLUG },
  });

  // Verify event exists and belongs to org
  const event = await prisma.eventureEvent.findFirstOrThrow({
    where: { id: EVENT_ID, organizationId: org.id },
    select: { id: true, title: true },
  });

  console.log(`Seeding price options for: "${event.title}" (${event.id})`);
  console.log(`Organization: ${org.id}\n`);

  let created = 0;
  let updated = 0;

  for (const option of PRICE_OPTIONS) {
    const result = await prisma.eventPriceOption.upsert({
      where: {
        organizationId_eventId_code: {
          organizationId: org.id,
          eventId: EVENT_ID,
          code: option.code,
        },
      },
      update: {
        name: option.name,
        category: option.category,
        flight: option.flight,
        priceCents: option.priceCents,
        includedFoursomes: option.includedFoursomes,
        includedGolfers: option.includedGolfers,
        includedNonGolfers: option.includedNonGolfers,
        includedAttendeeSlots: option.includedAttendeeSlots,
        participantEligible: option.participantEligible,
        isLimited: option.isLimited,
        sortOrder: option.sortOrder,
        isActive: true,
        archivedAt: null,
      },
      create: {
        organizationId: org.id,
        eventId: EVENT_ID,
        code: option.code,
        name: option.name,
        category: option.category,
        flight: option.flight,
        priceCents: option.priceCents,
        includedFoursomes: option.includedFoursomes,
        includedGolfers: option.includedGolfers,
        includedNonGolfers: option.includedNonGolfers,
        includedAttendeeSlots: option.includedAttendeeSlots,
        includedRepresentativeSlots: 0,
        participantEligible: option.participantEligible,
        createsSponsorRecord: false,
        isLimited: option.isLimited,
        isActive: true,
        requiresReview: false,
        sortOrder: option.sortOrder,
      },
    });

    const wasNew = result.updatedAt.getTime() - result.createdAt.getTime() < 500;
    if (wasNew) {
      created++;
      console.log(`  [created] ${option.code} — ${option.name}`);
    } else {
      updated++;
      console.log(`  [updated] ${option.code} — ${option.name}`);
    }
  }

  console.log(`\nDone. Created: ${created}  Updated: ${updated}  Total: ${PRICE_OPTIONS.length}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
