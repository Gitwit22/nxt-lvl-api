import { describe, expect, it } from "vitest";
import { parseCsvOrXlsx } from "../src/programs/eventure/services/attendee-import-parser.js";

describe("eventure attendee import parser", () => {
  it("normalizes payment fields from attendee import headers", () => {
    const parsed = parseCsvOrXlsx({
      csvContent: [
        "attendee name,payment status,amount due,amount paid,payment method,payment reference,payment notes,company",
        "Jane Doe,paid,\"$1,250.00\",1250,check,CHK-42,Deposit received,Acme Corp",
      ].join("\n"),
    });

    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      attendeeName: "Jane Doe",
      paymentStatus: "paid",
      amountExpected: 1250,
      amountPaid: 1250,
      paymentMethod: "check",
      paymentReference: "CHK-42",
      paymentNotes: "Deposit received",
      ticketBuyer: "Acme Corp",
    });
  });
});