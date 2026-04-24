/**
 * Lightweight metadata extractor for the Community Chronicle document intake pipeline.
 *
 * Goal: make every document searchable, categorizable, and reviewable.
 * We extract ONLY high-value searchable fields - no deep schema normalisation.
 *
 * Output fields (mirrors ExtractedMetadata in the frontend types):
 *   documentType         - canonical type key or "other_unclassified"
 *   sourceName           - who issued the document
 *   documentDate         - ISO date string from document text
 *   people[]             - person names
 *   companies[]          - organisation/company names
 *   locations[]          - cities, states, addresses
 *   referenceNumbers[]   - invoice #, grant #, case #, cheque #, etc.
 *   other[]              - anything useful that doesn't fit above
 *   confidence           - 0-1 per field that was extracted
 *   classificationStatus - known | other_unclassified
 *   classificationMatchedBy - rule | keyword | source | fingerprint | manual
 */

// -----------------------------------------------------------------------------
// Document type definitions
// -----------------------------------------------------------------------------

export const SYSTEM_DOCUMENT_TYPES = [
  "business_card",
  "form",
  "invoice",
  "statement",
  "voucher",
  "reimbursement_request",
  "receipt",
  "letter",
  "email_correspondence",
  "approval_message",
  "notice",
  "report",
  "sign_in_sheet",
  "donation_acknowledgment",
  "donation_form",
  "grant_award_letter",
  "deposit_confirmation",
  "check_image",
  "payroll_liability_report",
  "payroll_detail_report",
  "payroll_worksheet",
  "timesheet",
  "remittance_advice",
  "other_unclassified",
] as const;

export type SystemDocumentType = typeof SYSTEM_DOCUMENT_TYPES[number];

export const DOCUMENT_TYPE_LABELS: Record<SystemDocumentType, string> = {
  business_card:           "Business Card",
  form:                    "Form / Application",
  invoice:                 "Invoice",
  statement:               "Statement / Billing Summary",
  voucher:                 "Voucher / Payment Approval",
  reimbursement_request:   "Reimbursement Request",
  receipt:                 "Receipt / Acknowledgment",
  letter:                  "Letter / Correspondence",
  email_correspondence:    "Email Correspondence",
  approval_message:        "Approval Message",
  notice:                  "Notice / Government Document",
  report:                  "Report / Study",
  sign_in_sheet:           "Sign-In Sheet / Roster",
  donation_acknowledgment: "Donation Acknowledgment",
  donation_form:           "Donation / Contribution Form",
  grant_award_letter:      "Grant Award Letter",
  deposit_confirmation:    "Deposit Confirmation",
  check_image:             "Check Image",
  payroll_liability_report:"Payroll Liability Report",
  payroll_detail_report:   "Payroll Detail Report",
  payroll_worksheet:       "Payroll Worksheet / Summary",
  timesheet:               "Employee Timesheet",
  remittance_advice:       "Remittance / Payment Advice",
  other_unclassified:      "Other (Unclassified)",
};

// -----------------------------------------------------------------------------
// Classification rules - keyword matching per type
// -----------------------------------------------------------------------------

interface TypeRule {
  type: SystemDocumentType;
  keywords: string[];
  weight: number;
}

const TYPE_RULES: TypeRule[] = [
  {
    type: "invoice",
    keywords: [
      "invoice", "invoice #", "invoice number", "bill to", "amount due",
      "balance due", "total due", "remit payment", "due date", "net 30",
      "net 60", "purchase order", "line item", "qty", "quantity", "unit price",
      "subtotal", "tax amount", "vendor", "billing address",
    ],
    weight: 1.0,
  },
  {
    type: "receipt",
    keywords: [
      "receipt", "acknowledgment", "acknowledgement", "thank you for your",
      "your gift", "your donation", "your contribution", "payment received",
      "total received", "we received", "tax deductible", "501(c)(3)",
      "charitable contribution", "non-cash contribution", "in-kind",
      "no goods or services", "donation amount",
    ],
    weight: 1.0,
  },
  {
    type: "letter",
    keywords: [
      "dear ", "sincerely", "regards,", "to whom it may concern",
      "on behalf of", "we are pleased", "we regret", "we would like",
      "please find enclosed", "please find attached", "letter of",
      "re:", "subject:", "memo", "memorandum",
    ],
    weight: 0.9,
  },
  {
    type: "form",
    keywords: [
      "application", "form", "please complete", "please fill", "submit",
      "applicant name", "signature", "date signed", "authorized by",
      "registration", "enrollment", "pledge form", "pledge card",
      "credit card authorization", "w-9", "w9", "i-9",
    ],
    weight: 1.0,
  },
  {
    type: "sign_in_sheet",
    keywords: [
      "sign-in", "sign in sheet", "attendance", "attendees", "roster",
      "participant list", "name:", "signature:", "present:", "in attendance",
      "meeting attendance", "printed name", "sign here",
    ],
    weight: 1.0,
  },
  {
    type: "business_card",
    keywords: [
      "cell:", "mobile:", "office:", "fax:", "www.", "linkedin",
      "title:", "position:", "direct:", "ext.",
    ],
    weight: 0.7,
  },
  {
    type: "report",
    keywords: [
      "report", "findings", "analysis", "assessment", "evaluation",
      "summary", "executive summary", "introduction", "methodology",
      "conclusion", "recommendation", "data", "study", "research",
      "annual report", "quarterly report", "program report",
    ],
    weight: 0.8,
  },
  {
    type: "notice",
    keywords: [
      "notice", "official notice", "department of", "internal revenue service",
      "irs", "department of the treasury", "notice date", "tax notice",
      "you are required", "you must", "failure to comply", "penalty",
      "pursuant to", "ordinance", "statute", "regulation", "government",
    ],
    weight: 1.0,
  },
  {
    type: "statement",
    keywords: [
      "statement", "account statement", "billing summary",
      "statement period", "previous balance", "current balance",
      "ending balance", "payment due", "minimum payment",
      "statement date", "service period",
    ],
    weight: 0.9,
  },
  {
    type: "voucher",
    keywords: [
      "voucher", "voucher number", "voucher #", "payment voucher",
      "expense voucher", "cash voucher", "authorized voucher",
      "disbursement voucher", "voucher date", "petty cash",
    ],
    weight: 1.0,
  },
  {
    type: "reimbursement_request",
    keywords: [
      "reimbursement", "reimbursement request", "expense report",
      "expense claim", "request for reimbursement", "out-of-pocket",
      "mileage reimbursement", "travel expense", "employee expense",
      "please reimburse", "total expenses",
    ],
    weight: 1.0,
  },
  {
    type: "payroll_liability_report",
    keywords: [
      "payroll liability", "liability report", "tax liability",
      "federal withholding", "state withholding", "fica", "medicare",
      "unemployment tax", "payroll taxes", "liability period",
    ],
    weight: 1.0,
  },
  {
    type: "payroll_detail_report",
    keywords: [
      "payroll detail", "employee payroll detail", "earnings detail",
      "gross pay", "net pay", "deductions", "ytd earnings",
      "pay period", "employee id", "hours worked",
    ],
    weight: 1.0,
  },
  {
    type: "payroll_worksheet",
    keywords: [
      "payroll worksheet", "payroll summary", "check summary",
      "payroll register", "total payroll", "department totals",
      "earnings summary", "deduction summary", "payroll batch",
    ],
    weight: 0.95,
  },
  {
    type: "timesheet",
    keywords: [
      "timesheet", "time sheet", "clock in", "clock out",
      "time in", "time out", "hours worked", "regular hours",
      "overtime", "employee hours", "daily hours",
    ],
    weight: 1.0,
  },
  {
    type: "email_correspondence",
    keywords: [
      "from:", "to:", "cc:", "bcc:", "subject:", "sent:", "received:",
      "forwarded message", "original message", "reply to",
      "email address", "@", "gmail", "outlook", "yahoo mail",
    ],
    weight: 0.85,
  },
  {
    type: "approval_message",
    keywords: [
      "approved", "approval", "this is to confirm approval",
      "has been approved", "you are approved", "your request has been approved",
      "authorized", "board approved", "executive approval",
      "approval number", "approval date",
    ],
    weight: 0.9,
  },
  {
    type: "donation_acknowledgment",
    keywords: [
      "thank you for your donation", "thank you for your gift",
      "your generous donation", "donation receipt",
      "tax-deductible contribution", "no goods or services were provided",
      "501(c)(3)", "ein:", "tax identification",
      "your support", "acknowledgment of donation",
    ],
    weight: 1.0,
  },
  {
    type: "donation_form",
    keywords: [
      "donation form", "contribution form", "donor information",
      "gift amount", "pledge amount", "payment method",
      "tax deductible", "donation details", "donor signature",
      "campaign", "matching gift",
    ],
    weight: 1.0,
  },
  {
    type: "grant_award_letter",
    keywords: [
      "grant award", "award letter", "grant agreement", "award amount",
      "project period", "grant number", "federal award", "fain",
      "notice of award", "noa", "grantee", "sub-award",
      "cfda", "pass-through entity", "grant funds",
    ],
    weight: 1.0,
  },
  {
    type: "deposit_confirmation",
    keywords: [
      "deposit confirmation", "deposit receipt", "funds deposited",
      "ach deposit", "direct deposit confirmation", "wire transfer",
      "wire confirmation", "electronic funds transfer", "eft",
      "deposit slip", "deposit amount", "account credited",
    ],
    weight: 1.0,
  },
  {
    type: "check_image",
    keywords: [
      "pay to the order of", "memo:", "authorized signature",
      "void", "check number", "routing number", "account number",
      "bank name", "negotiable instrument", "cents",
    ],
    weight: 0.9,
  },
  {
    type: "remittance_advice",
    keywords: [
      "remittance", "remittance advice", "payment advice",
      "payment remittance", "invoice payment", "amount remitted",
      "apply payment", "reference invoice", "stub",
      "payment breakdown", "advice number",
    ],
    weight: 0.95,
  },
];

// -----------------------------------------------------------------------------
// Classification result
// -----------------------------------------------------------------------------

export interface DocumentTypeClassification {
  documentType: string;           // system type key or custom type key
  confidence: number;             // 0-1
  classificationStatus: "known" | "other_unclassified";
  classificationMatchedBy: "rule" | "keyword" | "source" | "fingerprint" | "manual";
}

const CONFIDENCE_THRESHOLD = 0.25;

export function classifyDocumentType(
  text: string,
  filename?: string | null,
  fingerprintTypes?: Array<{ key: string; phrases: string[]; companies: string[] }>,
): DocumentTypeClassification {
  const corpus = `${filename ?? ""}\n${text}`.toLowerCase();

  // 1. Try fingerprint matching first (learned patterns from reviewed docs)
  if (fingerprintTypes && fingerprintTypes.length > 0) {
    for (const fp of fingerprintTypes) {
      const matchedPhrases = fp.phrases.filter((p) => corpus.includes(p.toLowerCase()));
      const matchedCompanies = fp.companies.filter((c) => corpus.includes(c.toLowerCase()));
      const totalHints = fp.phrases.length + fp.companies.length;
      const totalMatches = matchedPhrases.length + matchedCompanies.length;
      if (totalHints > 0 && totalMatches / totalHints >= 0.5) {
        return {
          documentType: fp.key,
          confidence: Math.min(0.5 + (totalMatches / totalHints) * 0.5, 0.95),
          classificationStatus: "known",
          classificationMatchedBy: "fingerprint",
        };
      }
    }
  }

  // 2. Filename heuristics (fast path)
  if (filename) {
    const fn = filename.toLowerCase();
    if (fn.includes("invoice") || fn.includes("inv_") || fn.includes("bill")) {
      return { documentType: "invoice", confidence: 0.75, classificationStatus: "known", classificationMatchedBy: "rule" };
    }
    if (fn.includes("statement") || fn.includes("billing_summary") || fn.includes("acct_stmt")) {
      return { documentType: "statement", confidence: 0.78, classificationStatus: "known", classificationMatchedBy: "rule" };
    }
    if (fn.includes("receipt") || fn.includes("ack") || fn.includes("acknowledgment")) {
      return { documentType: "receipt", confidence: 0.75, classificationStatus: "known", classificationMatchedBy: "rule" };
    }
    if (fn.includes("sign_in") || fn.includes("signin") || fn.includes("roster") || fn.includes("attendance")) {
      return { documentType: "sign_in_sheet", confidence: 0.80, classificationStatus: "known", classificationMatchedBy: "rule" };
    }
    if (fn.includes("business_card") || fn.includes("vcard") || fn.includes("bcard")) {
      return { documentType: "business_card", confidence: 0.80, classificationStatus: "known", classificationMatchedBy: "rule" };
    }
    if (fn.includes("voucher")) {
      return { documentType: "voucher", confidence: 0.80, classificationStatus: "known", classificationMatchedBy: "rule" };
    }
    if (fn.includes("reimbursement") || fn.includes("expense_report") || fn.includes("expense_claim")) {
      return { documentType: "reimbursement_request", confidence: 0.80, classificationStatus: "known", classificationMatchedBy: "rule" };
    }
    if (fn.includes("payroll_liability") || fn.includes("liability_report")) {
      return { documentType: "payroll_liability_report", confidence: 0.84, classificationStatus: "known", classificationMatchedBy: "rule" };
    }
    if (fn.includes("payroll_detail") || fn.includes("detail_report")) {
      return { documentType: "payroll_detail_report", confidence: 0.84, classificationStatus: "known", classificationMatchedBy: "rule" };
    }
    if (fn.includes("payroll_worksheet") || fn.includes("payroll_summary") || fn.includes("check_summary")) {
      return { documentType: "payroll_worksheet", confidence: 0.82, classificationStatus: "known", classificationMatchedBy: "rule" };
    }
    if (fn.includes("timesheet") || fn.includes("time_sheet")) {
      return { documentType: "timesheet", confidence: 0.82, classificationStatus: "known", classificationMatchedBy: "rule" };
    }
    if (fn.includes("payroll") || fn.includes("pay_stub") || fn.includes("paystub") || fn.includes("payslip")) {
      return { documentType: "payroll_detail_report", confidence: 0.76, classificationStatus: "known", classificationMatchedBy: "rule" };
    }
    if (fn.includes("email") || fn.includes("correspondence") || fn.includes("message")) {
      return { documentType: "email_correspondence", confidence: 0.75, classificationStatus: "known", classificationMatchedBy: "rule" };
    }
    if (fn.includes("approval") || fn.includes("approved")) {
      return { documentType: "approval_message", confidence: 0.75, classificationStatus: "known", classificationMatchedBy: "rule" };
    }
    if (fn.includes("award_letter") || fn.includes("grant_award") || fn.includes("notice_of_award") || fn.includes("noa_")) {
      return { documentType: "grant_award_letter", confidence: 0.80, classificationStatus: "known", classificationMatchedBy: "rule" };
    }
    if (fn.includes("deposit_confirmation") || fn.includes("deposit_receipt") || fn.includes("wire_confirm")) {
      return { documentType: "deposit_confirmation", confidence: 0.80, classificationStatus: "known", classificationMatchedBy: "rule" };
    }
    if (fn.includes("check_image") || fn.includes("check_scan") || fn.includes("cheque")) {
      return { documentType: "check_image", confidence: 0.80, classificationStatus: "known", classificationMatchedBy: "rule" };
    }
    if (fn.includes("donation_ack") || fn.includes("donation_acknowledgment") || fn.includes("donation_receipt")) {
      return { documentType: "donation_acknowledgment", confidence: 0.80, classificationStatus: "known", classificationMatchedBy: "rule" };
    }
    if (fn.includes("donation_form") || fn.includes("contribution_form") || fn.includes("pledge_form")) {
      return { documentType: "donation_form", confidence: 0.82, classificationStatus: "known", classificationMatchedBy: "rule" };
    }
    if (fn.includes("remittance") || fn.includes("payment_advice")) {
      return { documentType: "remittance_advice", confidence: 0.82, classificationStatus: "known", classificationMatchedBy: "rule" };
    }
  }

  // 3. Keyword scoring
  const scores: Array<{ type: SystemDocumentType; score: number }> = [];
  for (const rule of TYPE_RULES) {
    let matchCount = 0;
    for (const kw of rule.keywords) {
      if (corpus.includes(kw)) matchCount++;
    }
    if (matchCount > 0) {
      const score = (matchCount / rule.keywords.length) * rule.weight;
      scores.push({ type: rule.type, score });
    }
  }

  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];

  if (!best || best.score < CONFIDENCE_THRESHOLD) {
    return {
      documentType: "other_unclassified",
      confidence: best?.score ?? 0,
      classificationStatus: "other_unclassified",
      classificationMatchedBy: "keyword",
    };
  }

  return {
    documentType: best.type,
    confidence: Math.min(best.score + 0.2, 0.95), // slight boost for keyword match
    classificationStatus: "known",
    classificationMatchedBy: "keyword",
  };
}

// -----------------------------------------------------------------------------
// Lightweight metadata extraction
// -----------------------------------------------------------------------------

export interface LightweightMetadata {
  sourceName: string | null;
  documentDate: string | null;
  people: string[];
  companies: string[];
  locations: string[];
  referenceNumbers: string[];
  other: string[];
  confidence: {
    sourceName: number;
    documentDate: number;
  };
}

type StepOneSource =
  | "header"
  | "title"
  | "table_headers"
  | "keywords"
  | "filename"
  | "body"
  | "fallback"
  | "manual";

export type StepOnePersonRole =
  | "primary_subject"
  | "sender"
  | "recipient"
  | "attendee"
  | "staff_contact"
  | "unknown_person_mention";

export interface StepOnePerson {
  name: string;
  role: StepOnePersonRole;
  confidence: number;
}

export interface StepOneIntakeMetadata {
  documentId: string | null;
  organization: {
    name: string | null;
    confidence: number;
    source: StepOneSource;
  };
  documentType: {
    value: string;
    confidence: number;
    source: StepOneSource[];
  };
  documentDate: {
    exactDate: string | null;
    month: number | null;
    year: number | null;
    confidence: number;
    source: StepOneSource;
  };
  people: StepOnePerson[];
  headerText: string;
  classificationVersion: "v1";
}

export interface StepOneExtractionResult {
  metadata: StepOneIntakeMetadata;
  lightweight: LightweightMetadata;
  classification: DocumentTypeClassification;
  searchTextSeed: string;
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)].filter(Boolean);
}

function normalizeForStepOne(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractHeaderZone(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(0, 24).join("\n");
}

function extractDateParts(value: string | null): { exactDate: string | null; month: number | null; year: number | null } {
  if (!value) {
    return { exactDate: null, month: null, year: null };
  }

  const iso = value.match(/^(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
  if (iso) {
    return {
      exactDate: value,
      month: Number(iso[2]),
      year: Number(iso[1]),
    };
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    const month = parsed.getUTCMonth() + 1;
    const year = parsed.getUTCFullYear();
    const hasDay = /\b\d{1,2}\b/.test(value) && /\b20\d{2}\b/.test(value);
    return {
      exactDate: hasDay ? parsed.toISOString().slice(0, 10) : null,
      month,
      year,
    };
  }

  const slash = value.match(/\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(20\d{2})\b/);
  if (slash) {
    return {
      exactDate: `${slash[3]}-${String(slash[1]).padStart(2, "0")}-${String(slash[2]).padStart(2, "0")}`,
      month: Number(slash[1]),
      year: Number(slash[3]),
    };
  }

  const year = value.match(/\b(20\d{2})\b/)?.[1];
  return {
    exactDate: null,
    month: null,
    year: year ? Number(year) : null,
  };
}

function normalizePersonName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

function extractPeopleWithRoles(text: string, documentType: string): StepOnePerson[] {
  const allPeople = extractPeople(text);
  const result = new Map<string, StepOnePerson>();

  const addPerson = (nameRaw: string, role: StepOnePersonRole, confidence: number) => {
    const name = normalizePersonName(nameRaw);
    if (!name) return;
    const key = name.toLowerCase();
    const existing = result.get(key);
    if (!existing || confidence > existing.confidence) {
      result.set(key, { name, role, confidence });
    }
  };

  const senderMatches = text.match(/(?:from|prepared by|authorized by|reviewed by|submitted by|contact)[:\s]+([A-Z][a-z]+\s+[A-Z][a-z]+)/gi) ?? [];
  for (const raw of senderMatches) {
    const name = raw.split(/[:\s]+/).slice(-2).join(" ");
    addPerson(name, "sender", 0.84);
  }

  const recipientMatches = text.match(/(?:to|dear)[:\s]+([A-Z][a-z]+\s+[A-Z][a-z]+)/gi) ?? [];
  for (const raw of recipientMatches) {
    const name = raw.split(/[:\s]+/).slice(-2).join(" ");
    addPerson(name, "recipient", 0.8);
  }

  const primaryMatches = text.match(/(?:participant|client|applicant|patient|resident|employee|student)\s*name[:\s]+([A-Z][a-z]+\s+[A-Z][a-z]+)/gi) ?? [];
  for (const raw of primaryMatches) {
    const name = raw.split(/[:\s]+/).slice(-2).join(" ");
    addPerson(name, "primary_subject", 0.88);
  }

  for (const person of allPeople) {
    if (documentType === "sign_in_sheet") {
      addPerson(person, "attendee", 0.72);
    } else {
      addPerson(person, "unknown_person_mention", 0.55);
    }
  }

  return Array.from(result.values()).slice(0, 30);
}

function inferDocumentTypeSources(
  headerText: string,
  bodyText: string,
  filename: string | null | undefined,
  classificationMatchedBy: DocumentTypeClassification["classificationMatchedBy"],
): StepOneSource[] {
  const sources = new Set<StepOneSource>();

  if (classificationMatchedBy === "manual") {
    sources.add("manual");
  }
  if (classificationMatchedBy === "keyword") {
    sources.add("keywords");
  }
  if (classificationMatchedBy === "rule") {
    sources.add(filename ? "filename" : "title");
  }
  if (classificationMatchedBy === "source") {
    sources.add("header");
  }
  if (classificationMatchedBy === "fingerprint") {
    sources.add("keywords");
    sources.add("header");
  }

  if (/\b(invoice|receipt|statement|intake form|sign\s*-?in|attendance|donation|grant|report|notice)\b/i.test(headerText)) {
    sources.add("title");
  }
  if (/\b(name|signature|date|amount|total|account|reference)\b/i.test(bodyText)) {
    sources.add("table_headers");
  }

  if (sources.size === 0) {
    sources.add("fallback");
  }

  return Array.from(sources);
}

function extractDocumentDate(text: string): { date: string | null; confidence: number } {
  // ISO format: 2024-01-15
  const iso = text.match(/\b(20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\b/)?.[1];
  if (iso) return { date: iso, confidence: 0.95 };

  // US format: January 15, 2024 or Jan 15, 2024
  const longDate = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(20\d{2})\b/i,
  )?.[0];
  if (longDate) return { date: longDate, confidence: 0.90 };

  // MM/DD/YYYY
  const slashDate = text.match(/\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(20\d{2})\b/)?.[0];
  if (slashDate) return { date: slashDate, confidence: 0.85 };

  // Date: label
  const labeledDate = text.match(/(?:date|dated|as of|effective)[:.\s]+([A-Z][a-z]+ \d{1,2},?\s+20\d{2}|\d{1,2}\/\d{1,2}\/20\d{2})/i)?.[1];
  if (labeledDate) return { date: labeledDate.trim(), confidence: 0.80 };

  // Year only fallback
  const year = text.match(/\b(20\d{2})\b/)?.[1];
  if (year) return { date: year, confidence: 0.50 };

  return { date: null, confidence: 0 };
}

function extractSourceName(text: string, filename?: string | null): { name: string | null; confidence: number } {
  // "From:" header
  const from = text.match(/^from:\s*(.+)$/im)?.[1]?.trim();
  if (from && from.length > 2 && from.length < 100) return { name: from, confidence: 0.90 };

  // Letterhead patterns: ALL CAPS org name in first 300 chars
  const header = text.slice(0, 300);
  const allCaps = header.match(/^([A-Z][A-Z\s&,.'()-]{5,60})$/m)?.[1]?.trim();
  if (allCaps) return { name: allCaps, confidence: 0.75 };

  // "Issued by:" or "Prepared by:"
  const issuedBy = text.match(/(?:issued by|prepared by|submitted by|from)[:.\s]+([A-Z][A-Za-z\s&.,'-]{3,60})/i)?.[1]?.trim();
  if (issuedBy) return { name: issuedBy, confidence: 0.80 };

  // Well-known issuers
  const knownIssuers = [
    "Internal Revenue Service",
    "IRS",
    "Department of the Treasury",
    "State of Michigan",
    "City of Detroit",
    "ADP",
    "PayPal",
    "FrontStream",
  ];
  for (const issuer of knownIssuers) {
    if (text.toLowerCase().includes(issuer.toLowerCase())) {
      return { name: issuer, confidence: 0.85 };
    }
  }

  // Fallback: first org-looking string in text
  const orgMatch = text.match(
    /\b([A-Z][A-Za-z&]+(?:\s+[A-Z][A-Za-z&]+){1,4})\s+(?:Inc\.?|LLC|Foundation|Committee|Board|Department|University|School|Council|Association|Corp\.?)\b/,
  )?.[0];
  if (orgMatch) return { name: orgMatch.trim(), confidence: 0.65 };

  // Filename hint as last resort
  if (filename) {
    const base = filename.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
    return { name: base, confidence: 0.30 };
  }

  return { name: null, confidence: 0 };
}

function extractPeople(text: string): string[] {
  const matches: string[] = [];

  // "Dear [Name]" patterns
  const dear = text.match(/\bDear\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?),/g) ?? [];
  for (const m of dear) {
    const name = m.replace(/^Dear\s+/i, "").replace(/,$/, "").trim();
    if (name) matches.push(name);
  }

  // "Signed by / Prepared by / Authorized by" patterns
  const signedBy = text.match(/(?:signed by|prepared by|authorized by|reviewed by|submitted by|from):\s*([A-Z][a-z]+\s+[A-Z][a-z]+)/gi) ?? [];
  for (const m of signedBy) {
    const name = m.split(/:\s*/)[1]?.trim();
    if (name) matches.push(name);
  }

  // Title-case name pairs that appear to be people
  const namePairs = text.match(/\b[A-Z][a-z]{1,20}\s+[A-Z][a-z]{1,20}\b/g) ?? [];
  const stopWords = new Set([
    "Dear Mr", "Dear Ms", "Dear Dr", "Thank You", "Grand Total",
    "Total Amount", "Line Item", "Net Proceeds", "Tax Exempt",
    "United States", "New York", "Los Angeles", "San Francisco",
  ]);
  for (const pair of namePairs) {
    if (!stopWords.has(pair) && pair.split(" ").every((w) => w.length > 1)) {
      matches.push(pair);
    }
  }

  return dedupe(matches).slice(0, 20);
}

function extractCompanies(text: string): string[] {
  const matches: string[] = [];

  // Legal entity suffixes
  const entityPattern = /\b([A-Z][A-Za-z&\s,.'()-]{3,60}?)\s+(?:Inc\.?|LLC|LLP|Corp\.?|Foundation|Committee|Board|Department|University|School|Council|Association|Organization|Institute)\b/g;
  let m: RegExpExecArray | null;
  while ((m = entityPattern.exec(text)) !== null) {
    const name = m[0].trim();
    if (name.length < 80) matches.push(name);
  }

  // "From: [Company]" or "Bill To:" patterns
  const billTo = text.match(/(?:bill to|billed to|client|customer|vendor):\s*([A-Z][A-Za-z\s&.,'-]{3,60})/gi) ?? [];
  for (const hit of billTo) {
    const name = hit.split(/:\s*/i)[1]?.trim();
    if (name) matches.push(name);
  }

  return dedupe(matches).slice(0, 15);
}

function extractLocations(text: string): string[] {
  const matches: string[] = [];

  // City, State ZIP patterns
  const cityStateZip = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?),\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/g) ?? [];
  matches.push(...cityStateZip);

  // "in [City]" patterns
  const inCity = text.match(/\b(?:in|at|from)\s+([A-Z][a-z]+(?:,\s+[A-Z][a-z]+)?)\b/g) ?? [];
  for (const hit of inCity) {
    const loc = hit.replace(/^(?:in|at|from)\s+/i, "").trim();
    if (loc.length > 2) matches.push(loc);
  }

  // Street addresses
  const addresses = text.match(/\b\d{1,6}\s+[A-Z][a-z]+\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way|Place|Pl)\b/g) ?? [];
  matches.push(...addresses);

  return dedupe(matches).slice(0, 15);
}

function extractReferenceNumbers(text: string): string[] {
  const matches: string[] = [];

  const patterns = [
    /(?:invoice\s*#?|inv\.?\s*#?|invoice\s*no\.?\s*)[:\s]*([A-Z0-9-]{3,25})/gi,
    /(?:check\s*#?|check\s*no\.?\s*|cheque\s*#?)[:\s]*([A-Z0-9-]{3,20})/gi,
    /(?:grant\s*#?|grant\s*no\.?\s*|award\s*#?)[:\s]*([A-Z0-9-]{3,25})/gi,
    /(?:case\s*#?|case\s*no\.?\s*|docket\s*#?)[:\s]*([A-Z0-9-]{3,25})/gi,
    /(?:po\s*#?|purchase\s*order\s*#?)[:\s]*([A-Z0-9-]{3,25})/gi,
    /(?:reference\s*#?|ref\.?\s*#?|ref\s*no\.?\s*)[:\s]*([A-Z0-9-]{3,25})/gi,
    /(?:account\s*#?|acct\.?\s*#?|account\s*no\.?\s*)[:\s]*([A-Z0-9-]{3,25})/gi,
    /(?:confirmation\s*#?|conf\.?\s*#?)[:\s]*([A-Z0-9-]{3,25})/gi,
  ];

  for (const pattern of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const ref = m[1]?.trim();
      if (ref && ref.length >= 3) matches.push(ref);
    }
  }

  return dedupe(matches).slice(0, 15);
}

function extractOther(text: string, people: string[], companies: string[]): string[] {
  const other: string[] = [];
  const knownEntities = new Set([...people.map((p) => p.toLowerCase()), ...companies.map((c) => c.toLowerCase())]);

  // Dollar amounts
  const amounts = text.match(/\$\s*[\d,]+(?:\.\d{2})?/g) ?? [];
  if (amounts.length > 0) {
    const uniqueAmounts = dedupe(amounts).slice(0, 5);
    other.push(...uniqueAmounts.map((a) => `Amount: ${a.replace(/\s/g, "")}`));
  }

  // Email addresses
  const emails = text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g) ?? [];
  other.push(...dedupe(emails).slice(0, 5));

  // Phone numbers
  const phones = text.match(/\b(?:\+1[-.\s]?)?\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})\b/g) ?? [];
  other.push(...dedupe(phones).slice(0, 5).map((p) => `Phone: ${p}`));

  // Notable standalone words/phrases not already captured
  const importantKeywords = [
    "confidential", "draft", "final", "approved", "pending",
    "urgent", "past due", "overdue", "void", "canceled", "corrected",
  ];
  for (const kw of importantKeywords) {
    if (text.toLowerCase().includes(kw) && !knownEntities.has(kw)) {
      other.push(kw.charAt(0).toUpperCase() + kw.slice(1));
    }
  }

  return dedupe(other).slice(0, 20);
}

export interface PostClassificationEnrichmentInput {
  text: string;
  documentType: string;
  sourceName?: string | null;
  documentDate?: string | null;
  companies?: string[];
  people?: string[];
  locations?: string[];
  referenceNumbers?: string[];
}

export interface PostClassificationEnrichment {
  tags: string[];
  keywords: string[];
}

function extractMonthYearTag(value?: string | null): string | null {
  if (!value) return null;
  const parsed = extractDateParts(value);
  if (!parsed.year) return null;
  if (!parsed.month) return String(parsed.year);

  const monthNames = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  return `${monthNames[parsed.month - 1]} ${parsed.year}`;
}

function extractRepeatedHeaderPhrases(text: string): string[] {
  const stopPhrases = new Set([
    "page",
    "continued",
    "account number",
    "statement date",
  ]);

  const counts = new Map<string, number>();
  const lines = text
    .split("\n")
    .slice(0, 40)
    .map((line) => line.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 10 && line.length <= 64)
    .filter((line) => !/^\d+[\d\s\-./]*$/.test(line));

  for (const line of lines) {
    if (stopPhrases.has(line)) continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([phrase]) => phrase)
    .slice(0, 3);
}

export function enrichPostClassificationMetadata(input: PostClassificationEnrichmentInput): PostClassificationEnrichment {
  const text = input.text || "";
  const corpus = text.toLowerCase();
  const type = (input.documentType || "other_unclassified").toLowerCase();
  const tags = new Set<string>();
  const keywords = new Set<string>();

  tags.add(type.replace(/_/g, " "));
  keywords.add(type);

  const typeClues: Array<{ test: RegExp; tags: string[]; keywords: string[] }> = [
    {
      test: /statement|account statement|statement period|ending balance|available balance/i,
      tags: ["bank statement", "financial", "statement period"],
      keywords: ["statement", "account statement", "ending balance", "available balance"],
    },
    {
      test: /invoice|bill to|amount due|purchase order|line item/i,
      tags: ["invoice", "billing", "vendor"],
      keywords: ["invoice number", "amount due", "purchase order", "vendor"],
    },
    {
      test: /payroll|pay period|gross pay|net pay|deductions|timesheet/i,
      tags: ["payroll", "employee compensation"],
      keywords: ["pay period", "gross pay", "net pay", "deductions", "hours worked"],
    },
    {
      test: /grant|donation|award amount|grantee|notice of award|501\(c\)\(3\)/i,
      tags: ["funding", "nonprofit"],
      keywords: ["grant", "donation", "award", "grantee", "charitable"],
    },
    {
      test: /notice|department of|internal revenue service|irs|treasury|penalty/i,
      tags: ["official notice", "government"],
      keywords: ["notice", "government agency", "irs", "treasury"],
    },
    {
      test: /from:|to:|subject:|dear\s|sincerely|regards/i,
      tags: ["correspondence"],
      keywords: ["sender", "recipient", "subject line"],
    },
  ];

  for (const clue of typeClues) {
    if (!clue.test.test(corpus)) continue;
    for (const tag of clue.tags) tags.add(tag);
    for (const keyword of clue.keywords) keywords.add(keyword);
  }

  const accountProductClues = [
    "checking",
    "savings",
    "money market",
    "credit card",
    "wire transfer",
    "ach",
    "routing number",
    "account ending",
  ];
  for (const clue of accountProductClues) {
    if (corpus.includes(clue)) {
      tags.add(clue);
      keywords.add(clue);
    }
  }

  const sourceName = input.sourceName?.trim();
  if (sourceName) {
    tags.add(sourceName.toLowerCase());
    keywords.add(sourceName.toLowerCase());
  }

  for (const company of input.companies ?? []) {
    const value = company.trim().toLowerCase();
    if (!value) continue;
    tags.add(value);
    keywords.add(value);
  }

  for (const person of input.people ?? []) {
    const value = person.trim().toLowerCase();
    if (!value) continue;
    keywords.add(value);
  }

  for (const location of input.locations ?? []) {
    const value = location.trim().toLowerCase();
    if (!value) continue;
    keywords.add(value);
  }

  for (const reference of input.referenceNumbers ?? []) {
    const value = reference.trim().toLowerCase();
    if (!value) continue;
    keywords.add(value);
  }

  const monthYear = extractMonthYearTag(input.documentDate);
  if (monthYear) {
    tags.add(monthYear);
    keywords.add(monthYear);
  }

  const repeatedPhrases = extractRepeatedHeaderPhrases(text);
  for (const phrase of repeatedPhrases) {
    tags.add(phrase);
    keywords.add(phrase);
  }

  return {
    tags: Array.from(tags)
      .map((value) => value.replace(/\s+/g, " ").trim())
      .filter((value) => value.length >= 3)
      .slice(0, 24),
    keywords: Array.from(keywords)
      .map((value) => value.replace(/\s+/g, " ").trim())
      .filter((value) => value.length >= 2)
      .slice(0, 50),
  };
}

// -----------------------------------------------------------------------------
// Main entrypoint
// -----------------------------------------------------------------------------

export function extractLightweightMetadata(
  text: string,
  filename?: string | null,
): LightweightMetadata {
  const { date, confidence: dateConf } = extractDocumentDate(text);
  const { name: source, confidence: sourceConf } = extractSourceName(text, filename);
  const people = extractPeople(text);
  const companies = extractCompanies(text);
  const locations = extractLocations(text);
  const referenceNumbers = extractReferenceNumbers(text);
  const other = extractOther(text, people, companies);

  return {
    sourceName: source,
    documentDate: date,
    people,
    companies,
    locations,
    referenceNumbers,
    other,
    confidence: {
      sourceName: sourceConf,
      documentDate: dateConf,
    },
  };
}

export function extractStepOneIntakeMetadata(input: {
  text: string;
  filename?: string | null;
  documentId?: string | null;
  fingerprintTypes?: Array<{ key: string; phrases: string[]; companies: string[] }>;
}): StepOneExtractionResult {
  const normalizedText = normalizeForStepOne(input.text);
  const headerText = extractHeaderZone(normalizedText);
  const lightweight = extractLightweightMetadata(normalizedText, input.filename);

  // Header-first classification, then fallback to full text if confidence is weak.
  const headerClassification = classifyDocumentType(headerText, input.filename, input.fingerprintTypes);
  const classification =
    headerClassification.confidence >= 0.4
      ? headerClassification
      : classifyDocumentType(normalizedText, input.filename, input.fingerprintTypes);

  const orgFromHeader = extractSourceName(headerText, input.filename);
  const orgFromBody = orgFromHeader.name ? orgFromHeader : extractSourceName(normalizedText, input.filename);
  const dateFromHeader = extractDocumentDate(headerText);
  const dateCandidate = dateFromHeader.date ? dateFromHeader : extractDocumentDate(normalizedText);
  const dateParts = extractDateParts(dateCandidate.date);

  const people = extractPeopleWithRoles(normalizedText, classification.documentType);
  const documentTypeSources = inferDocumentTypeSources(
    headerText,
    normalizedText,
    input.filename,
    classification.classificationMatchedBy,
  );

  const metadata: StepOneIntakeMetadata = {
    documentId: input.documentId ?? null,
    organization: {
      name: orgFromBody.name,
      confidence: orgFromBody.confidence,
      source: orgFromHeader.name ? "header" : (input.filename ? "filename" : "body"),
    },
    documentType: {
      value: classification.documentType,
      confidence: classification.confidence,
      source: documentTypeSources,
    },
    documentDate: {
      exactDate: dateParts.exactDate,
      month: dateParts.month,
      year: dateParts.year,
      confidence: dateCandidate.confidence,
      source: dateFromHeader.date ? "header" : "body",
    },
    people,
    headerText,
    classificationVersion: "v1",
  };

  const searchTextSeed = [
    metadata.organization.name ?? "",
    metadata.documentType.value,
    metadata.documentDate.exactDate ?? "",
    metadata.documentDate.month ? String(metadata.documentDate.month) : "",
    metadata.documentDate.year ? String(metadata.documentDate.year) : "",
    ...metadata.people.map((p) => p.name),
    headerText,
  ]
    .join(" ")
    .trim();

  return {
    metadata,
    lightweight,
    classification,
    searchTextSeed,
  };
}
