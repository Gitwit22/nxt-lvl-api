/**
 * Lightweight metadata extractor for the Community Chronicle document intake pipeline.
 *
 * Goal: make every document searchable, categorizable, and reviewable.
 * We extract ONLY high-value searchable fields — no deep schema normalisation.
 *
 * Output fields (mirrors ExtractedMetadata in the frontend types):
 *   documentType         — canonical type key or "other_unclassified"
 *   sourceName           — who issued the document
 *   documentDate         — ISO date string from document text
 *   people[]             — person names
 *   companies[]          — organisation/company names
 *   locations[]          — cities, states, addresses
 *   referenceNumbers[]   — invoice #, grant #, case #, cheque #, etc.
 *   other[]              — anything useful that doesn't fit above
 *   confidence           — 0–1 per field that was extracted
 *   classificationStatus — known | other_unclassified
 *   classificationMatchedBy — rule | keyword | source | fingerprint | manual
 */

// ─────────────────────────────────────────────────────────────────────────────
// Document type definitions
// ─────────────────────────────────────────────────────────────────────────────

export const SYSTEM_DOCUMENT_TYPES = [
  "invoice",
  "receipt",
  "letter",
  "form",
  "sign_in_sheet",
  "business_card",
  "report",
  "notice",
  "other_unclassified",
] as const;

export type SystemDocumentType = typeof SYSTEM_DOCUMENT_TYPES[number];

export const DOCUMENT_TYPE_LABELS: Record<SystemDocumentType, string> = {
  invoice:          "Invoice",
  receipt:          "Receipt / Acknowledgment",
  letter:           "Letter / Correspondence",
  form:             "Form / Application",
  sign_in_sheet:    "Sign-In Sheet / Roster",
  business_card:    "Business Card",
  report:           "Report / Study",
  notice:           "Notice / Government Document",
  other_unclassified: "Other (Unclassified)",
};

// ─────────────────────────────────────────────────────────────────────────────
// Classification rules — keyword matching per type
// ─────────────────────────────────────────────────────────────────────────────

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
];

// ─────────────────────────────────────────────────────────────────────────────
// Classification result
// ─────────────────────────────────────────────────────────────────────────────

export interface DocumentTypeClassification {
  documentType: string;           // system type key or custom type key
  confidence: number;             // 0–1
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
    if (fn.includes("receipt") || fn.includes("ack") || fn.includes("acknowledgment")) {
      return { documentType: "receipt", confidence: 0.75, classificationStatus: "known", classificationMatchedBy: "rule" };
    }
    if (fn.includes("sign_in") || fn.includes("signin") || fn.includes("roster") || fn.includes("attendance")) {
      return { documentType: "sign_in_sheet", confidence: 0.80, classificationStatus: "known", classificationMatchedBy: "rule" };
    }
    if (fn.includes("business_card") || fn.includes("vcard") || fn.includes("bcard")) {
      return { documentType: "business_card", confidence: 0.80, classificationStatus: "known", classificationMatchedBy: "rule" };
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

// ─────────────────────────────────────────────────────────────────────────────
// Lightweight metadata extraction
// ─────────────────────────────────────────────────────────────────────────────

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

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)].filter(Boolean);
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

// ─────────────────────────────────────────────────────────────────────────────
// Main entrypoint
// ─────────────────────────────────────────────────────────────────────────────

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
