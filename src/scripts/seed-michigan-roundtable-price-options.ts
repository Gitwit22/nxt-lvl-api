/**
 * Seed script: Michigan Roundtable Golf Classic 2026 — Event Price Catalog
 *
 * Usage:
 *   npx ts-node --esm src/scripts/seed-michigan-roundtable-price-options.ts <organizationId> <eventId>
 *
 * The script is idempotent — it upserts on (organizationId, eventId, code).
 */

import { prisma } from "../core/db/prisma.js";

export const michiganRoundtableGolfClassic2026PriceOptions = [
  {
    code: "TITLE_SPONSOR",
    name: "Michigan Roundtable Classic Title Sponsor",
    category: "SPONSORSHIP",
    flight: "PM",
    priceCents: 3_000_000,
    includedFoursomes: 3,
    includedGolfers: 16,
    includedNonGolfers: 6,
    includedAttendeeSlots: 22,
    participantEligible: true,
    createsSponsorRecord: true,
    isLimited: true,
    isActive: true,
    requiresReview: true,
    reviewNote: "Package text says 3 PM foursomes but also says 16 golfers. Verify with event organizer.",
    sortOrder: 10,
    benefits: [
      "Premier logo placement on all event materials",
      "Speaking during awards program",
      "Branding at registration/reception",
      "Logo on golfer gift bags",
      "Featured recognition in MRJC marketing",
      "6 Non-Golfer tickets",
    ],
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
    participantEligible: true,
    createsSponsorRecord: true,
    isLimited: true,
    isActive: true,
    requiresReview: false,
    sortOrder: 20,
    benefits: [
      "Branding at registration and reception",
      "Recognition and speaking during awards program",
      "Logo on event signage and marketing",
      "Recognition in MRJC marketing",
      "4 Non-Golfer tickets",
    ],
  },
  {
    code: "JUSTICE_LOUNGE_SPONSOR",
    name: "19th Hole Justice Lounge Evening Reception Sponsor",
    category: "SPONSORSHIP",
    flight: "PM",
    priceCents: 1_500_000,
    includedFoursomes: 1,
    includedGolfers: 4,
    includedNonGolfers: 2,
    includedAttendeeSlots: 6,
    participantEligible: true,
    createsSponsorRecord: true,
    isLimited: true,
    isActive: true,
    requiresReview: false,
    sortOrder: 30,
    benefits: [
      "Naming rights to post-golf reception",
      "Branding at networking reception",
      "Speaking opportunity",
      "Naming of signature drink",
      "2 Non-Golfer tickets",
    ],
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
    participantEligible: true,
    createsSponsorRecord: true,
    isLimited: true,
    isActive: true,
    requiresReview: false,
    sortOrder: 40,
    benefits: [
      "Naming rights to lunch",
      "Branding during lunch awards",
      "Speaking opportunity during lunch",
      "2 Non-Golfer tickets",
    ],
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
    participantEligible: true,
    createsSponsorRecord: true,
    isLimited: true,
    isActive: true,
    requiresReview: false,
    sortOrder: 50,
    benefits: [
      "Logo on golfer gifts",
      "Recognition at registration",
    ],
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
    participantEligible: true,
    createsSponsorRecord: true,
    isLimited: true,
    isActive: true,
    requiresReview: false,
    sortOrder: 60,
    benefits: [
      "Logo on beverage carts",
      "Branded koozies",
    ],
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
    participantEligible: true,
    createsSponsorRecord: true,
    isLimited: true,
    isActive: true,
    requiresReview: false,
    sortOrder: 70,
    benefits: [
      "Branding during morning check-in",
      "Signage at breakfast station",
    ],
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
    participantEligible: true,
    createsSponsorRecord: true,
    isLimited: true,
    isActive: true,
    requiresReview: false,
    sortOrder: 80,
    benefits: [
      "Branding at wellness activation",
      "Onsite wellness activations for golfers and attendees",
    ],
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
    includedRepresentativeSlots: 1,
    participantEligible: false,
    createsSponsorRecord: true,
    isLimited: false,
    isActive: true,
    requiresReview: false,
    sortOrder: 90,
    benefits: [
      "Branded signage",
      "On-course activation opportunities",
      "Company representatives at hole",
    ],
  },
  {
    code: "PM_FOURSOME",
    name: "1 - PM Flight Foursome",
    category: "FOURSOME",
    flight: "PM",
    priceCents: 400_000,
    includedFoursomes: 1,
    includedGolfers: 4,
    includedNonGolfers: 0,
    includedAttendeeSlots: 4,
    participantEligible: true,
    createsSponsorRecord: false,
    isLimited: false,
    isActive: true,
    requiresReview: false,
    sortOrder: 100,
    benefits: [
      "1 foursome for 18 holes",
      "Name and logo on participant signage and website",
      "1 golf cart per foursome",
      "Lunch",
      "2 complimentary drink tickets per golfer",
      "Post-round reception with appetizers and open bar tab",
    ],
  },
  {
    code: "AM_FOURSOME_DTE",
    name: "1 - AM Flight Foursome Presented by DTE",
    category: "FOURSOME",
    flight: "AM",
    priceCents: 400_000,
    includedFoursomes: 1,
    includedGolfers: 4,
    includedNonGolfers: 0,
    includedAttendeeSlots: 4,
    participantEligible: true,
    createsSponsorRecord: false,
    isLimited: false,
    isActive: true,
    requiresReview: false,
    sortOrder: 110,
    benefits: [
      "1 foursome for 18 holes",
      "Name and logo on participant signage and website",
      "1 golf cart per foursome",
      "2 complimentary drink tickets per golfer",
      "Breakfast",
      "Lunch with bar",
    ],
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
    participantEligible: false,
    createsSponsorRecord: false,
    isLimited: false,
    isActive: true,
    requiresReview: false,
    sortOrder: 120,
    benefits: [
      "Lunch",
      "2 complimentary drink tickets",
      "Post-round reception with appetizers and open bar tab",
      "Golf simulator access",
    ],
  },
  {
    code: "AM_NON_GOLFER_DTE",
    name: "Non-Golfer AM Flight Presented by DTE",
    category: "NON_GOLFER",
    flight: "AM",
    priceCents: 25_000,
    includedFoursomes: 0,
    includedGolfers: 0,
    includedNonGolfers: 1,
    includedAttendeeSlots: 1,
    participantEligible: false,
    createsSponsorRecord: false,
    isLimited: false,
    isActive: true,
    requiresReview: false,
    sortOrder: 130,
    benefits: [
      "Breakfast",
      "2 complimentary drink tickets per person",
      "Lunch with bar",
      "Golf simulator access",
    ],
  },
] as const;

export async function seedMichiganRoundtablePriceOptions(organizationId: string, eventId: string) {
  let created = 0;
  let updated = 0;

  for (const option of michiganRoundtableGolfClassic2026PriceOptions) {
    const existing = await prisma.eventPriceOption.findFirst({
      where: { organizationId, eventId, code: option.code },
    });

    if (existing) {
      await prisma.eventPriceOption.update({
        where: { id: existing.id },
        data: {
          ...option,
          benefits: option.benefits as unknown as object,
          flight: option.flight ?? null,
          archivedAt: null,
        },
      });
      updated += 1;
    } else {
      await prisma.eventPriceOption.create({
        data: {
          organizationId,
          eventId,
          ...option,
          benefits: option.benefits as unknown as object,
          flight: option.flight ?? null,
          includedRepresentativeSlots: "includedRepresentativeSlots" in option
            ? (option as { includedRepresentativeSlots: number }).includedRepresentativeSlots
            : 0,
        },
      });
      created += 1;
    }
  }

  return { created, updated, total: created + updated };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

const [, , organizationId, eventId] = process.argv;

if (!organizationId || !eventId) {
  console.error("Usage: ts-node seed-michigan-roundtable-price-options.ts <organizationId> <eventId>");
  process.exit(1);
}

seedMichiganRoundtablePriceOptions(organizationId, eventId)
  .then((result) => {
    console.log(`Seeded Michigan Roundtable price options: ${result.created} created, ${result.updated} updated`);
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error("Seed failed:", error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
