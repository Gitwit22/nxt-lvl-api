import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "./core/db/prisma.js";
import { logger } from "./logger.js";
import {
  MAX_ATTEMPTS,
  JOB_TIMEOUT_MS,
  RETRY_BACKOFF_BASE_MS,
  SCANNED_PDF_WORDS_PER_PAGE_THRESHOLD,
  OCR_CONFIDENCE_REVIEW_THRESHOLD,
  MAX_FILE_SIZE_BYTES,
  LLAMA_CLASSIFY_AUTO_ACCEPT_THRESHOLD,
  LLAMA_CLASSIFY_REVIEW_THRESHOLD,
} from "./core/config/env.js";
import {
  classifyDocumentWithCoreApi,
  type ChronicleClassificationResult,
} from "./core/services/documentIntelligence/coreApiClient.js";
import {
  classifyDocumentType,
  extractStepOneIntakeMetadata,
} from "./core/services/documentIntelligence/lightweightMetadata.js";
import { isR2Configured, isR2Key, downloadFromR2 } from "./core/storage/r2.js";
import {
  canUseSharedParser,
  getActiveParseProvider,
  parseDocumentWithSharedService,
} from "./core/services/parse/documentParseService.js";
import type { TenantScope } from "./tenant.js";

let workerRunning = false;
let workerTimer: NodeJS.Timeout | null = null;
let workerLastTickAt: string | null = null;

// ---------------------------------------------------------------------------
// Extraction result shape
// ---------------------------------------------------------------------------

interface ExtractionResult {
  text: string;
  confidence: number;
  method: "text" | "pdf" | "pdf_scanned" | "ocr" | "llama_cloud" | "core_api" | "unsupported";
  pageCount?: number;
  warnings?: string[];
}

type ExtractionContext = {
  documentId?: string;
  jobId?: string;
};

type EntityExtraction = {
  people: string[];
  organizations: string[];
  locations: string[];
  addresses: string[];
  phoneNumbers: string[];
  grantNumbers: string[];
};

type TimeLabel = {
  exactDate: string | null;
  approximateYear: number | null;
  decade: string | null;
  confidence: number;
};

type TopicLabel = {
  label: string;
  confidence: number;
};

type AutoLabelingResult = {
  documentType: string;
  documentTypeConfidence: number;
  topicLabels: TopicLabel[];
  timeLabel: TimeLabel;
  entities: EntityExtraction;
  canonicalType: string;
  subtype: string | null;
  templateSignature: string;
  confidenceNarrative: string[];
};

type Fingerprint = {
  exactTextHash: string;
  textLength: number;
  tokenCount: number;
  fuzzySignature: string[];
  templateSignature: string;
  semanticVector: number[];
  fileHash: string | null;
};

type SimilarityResult = {
  duplicateOf: string | null;
  similarTo: Array<{ id: string; score: number; reason: string }>;
  priorVersions: Array<{ id: string; score: number }>;
  recurringSeriesName: string | null;
  clusterId: string;
};

type FamilyResult = {
  familyId: string;
  confidence: number;
  rationale: string[];
};

const DOCUMENT_TYPE_RULES: Array<{ type: string; keywords: string[] }> = [
  {
    type: "tax notice",
    keywords: [
      "internal revenue service",
      "irs",
      "department of the treasury",
      "employer identification number",
      "tax notice",
      "notice date",
    ],
  },
  {
    type: "irs correspondence",
    keywords: ["internal revenue service", "irs", "correspondence", "notice", "treasury"],
  },
  { type: "meeting minutes", keywords: ["meeting minutes", "agenda", "quorum", "motion", "adjourned"] },
  { type: "flyer", keywords: ["flyer", "join us", "registration", "save the date", "event"] },
  { type: "invoice", keywords: ["invoice", "amount due", "bill to", "remit"] },
  { type: "budget", keywords: ["budget", "projected", "fiscal", "line item", "appropriation"] },
  { type: "grant letter", keywords: ["grant", "award", "funded", "letter of award"] },
  { type: "application", keywords: ["application", "applicant", "submission", "eligibility"] },
  { type: "newsletter", keywords: ["newsletter", "highlights", "updates", "edition"] },
  { type: "legal doc", keywords: ["agreement", "statute", "compliance", "legal", "whereas"] },
  { type: "memo", keywords: ["memo", "memorandum", "to:", "from:"] },
  { type: "report", keywords: ["report", "analysis", "summary", "findings"] },
  { type: "roster", keywords: ["roster", "attendee", "sign-in", "participant list"] },
  { type: "correspondence", keywords: ["dear", "sincerely", "regards", "correspondence"] },
];

const TOPIC_RULES: Array<{ label: string; keywords: string[] }> = [
  {
    label: "tax",
    keywords: [
      "irs",
      "internal revenue service",
      "tax",
      "ein",
      "employer identification number",
      "department of the treasury",
    ],
  },
  {
    label: "government notice",
    keywords: ["notice", "notice date", "official notice", "department of the treasury", "irs"],
  },
  {
    label: "compliance",
    keywords: ["compliance", "filing", "tax filing", "requirements", "correspondence"],
  },
  { label: "housing", keywords: ["housing", "tenant", "homeownership", "residential", "rent"] },
  { label: "education", keywords: ["education", "school", "student", "curriculum", "enrollment"] },
  { label: "funding", keywords: ["funding", "grant", "budget", "donation", "reimbursement"] },
  { label: "outreach", keywords: ["outreach", "community", "awareness", "engagement"] },
  { label: "events", keywords: ["event", "banquet", "conference", "workshop", "calendar"] },
  { label: "board governance", keywords: ["board", "governance", "committee", "bylaws", "election"] },
  { label: "partnerships", keywords: ["partner", "partnership", "collaboration", "coalition"] },
];

const FAMILY_COMPLEMENTS = new Set([
  "agenda|meeting minutes",
  "meeting minutes|roster",
  "meeting minutes|flyer",
  "application|grant letter",
  "application|budget",
  "grant letter|budget",
  "grant letter|report",
  "invoice|budget",
]);

function toLowerWords(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function bounded(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function tokenizeForSimilarity(input: string): string[] {
  const words = toLowerWords(input).filter((w) => w.length > 2);
  const stopWords = new Set([
    "the", "and", "for", "with", "from", "that", "this", "your", "you", "our", "are", "was", "were", "will", "have",
  ]);
  return words.filter((word) => !stopWords.has(word));
}

function ngrams(text: string, size = 3): Set<string> {
  const normalized = normalizeText(text).replace(/\s/g, "");
  const set = new Set<string>();
  if (normalized.length <= size) {
    if (normalized.length > 0) set.add(normalized);
    return set;
  }
  for (let i = 0; i <= normalized.length - size; i += 1) {
    set.add(normalized.slice(i, i + size));
  }
  return set;
}

function jaccard(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 || setB.size === 0) return 0;
  let overlap = 0;
  for (const item of setA) {
    if (setB.has(item)) overlap += 1;
  }
  return overlap / (setA.size + setB.size - overlap);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function simpleStem(token: string): string {
  if (token.endsWith("ing") && token.length > 5) return token.slice(0, -3);
  if (token.endsWith("ed") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("es") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("s") && token.length > 3) return token.slice(0, -1);
  return token;
}

function buildSemanticVector(text: string, dims = 48): number[] {
  const vec = new Array<number>(dims).fill(0);
  for (const token of tokenizeForSimilarity(text)) {
    const digest = crypto.createHash("md5").update(token).digest();
    const idx = digest[0] % dims;
    vec[idx] += 1;
  }

  const magnitude = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) return vec;
  return vec.map((value) => Number((value / magnitude).toFixed(6)));
}

function getTemplateSignature(text: string, title: string): string {
  const baseLines = [title, ...text.split(/\n+/).slice(0, 8)]
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((line) => line.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " "));
  return sha256(baseLines.join("|")).slice(0, 20);
}

function extractEntities(text: string): EntityExtraction {
  const phoneMatches = text.match(/\b(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g) ?? [];
  const grantMatches = text.match(/\b(?:grant|award|contract)[-\s#:]?[a-z0-9-]{3,}\b/gi) ?? [];
  const addressMatches = text.match(/\b\d{1,6}\s+[A-Za-z0-9.\s]+\s(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct)\b/gi) ?? [];

  const orgMatches = text.match(/\b(?:[A-Z][A-Za-z&]+(?:\s+[A-Z][A-Za-z&]+){0,4})\s(?:Inc\.?|LLC|Foundation|Committee|Board|Department|University|School|Council|Association)\b/g) ?? [];
  const personMatches = text.match(/\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/g) ?? [];
  const locationMatches = text.match(/\b(?:in|at)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\b/g) ?? [];

  const dedupe = (items: string[]): string[] => [...new Set(items.map((v) => v.trim()).filter(Boolean))].slice(0, 25);

  return {
    people: dedupe(personMatches).filter((name) => !name.includes("Dear") && !name.includes("Sincerely")),
    organizations: dedupe(orgMatches),
    locations: dedupe(locationMatches.map((m) => m.replace(/^(?:in|at)\s+/i, ""))),
    addresses: dedupe(addressMatches),
    phoneNumbers: dedupe(phoneMatches),
    grantNumbers: dedupe(grantMatches),
  };
}

function extractTimeLabel(text: string): TimeLabel {
  const exact = text.match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})\b/i)?.[0] ?? null;

  const years = (text.match(/\b(19\d{2}|20\d{2})\b/g) ?? [])
    .map((y) => Number(y))
    .filter((y) => Number.isFinite(y));
  const approximateYear = years.length > 0 ? years[0] : null;
  const decade = approximateYear !== null ? `${Math.floor(approximateYear / 10) * 10}s` : null;

  let confidence = 0.25;
  if (exact) confidence = 0.92;
  else if (approximateYear !== null) confidence = 0.68;
  else if (decade) confidence = 0.5;

  return {
    exactDate: exact,
    approximateYear,
    decade,
    confidence,
  };
}

function classifyDocumentTypeAndTopics(title: string, text: string): AutoLabelingResult {
  const corpus = `${title}\n${text}`.toLowerCase();

  let bestType = "report";
  let bestTypeScore = 0;
  for (const rule of DOCUMENT_TYPE_RULES) {
    const matches = rule.keywords.filter((keyword) => corpus.includes(keyword)).length;
    const score = matches / rule.keywords.length;
    if (score > bestTypeScore) {
      bestType = rule.type;
      bestTypeScore = score;
    }
  }

  const topicLabels: TopicLabel[] = TOPIC_RULES
    .map((rule) => {
      const hits = rule.keywords.filter((keyword) => corpus.includes(keyword)).length;
      const confidence = bounded(hits / Math.max(rule.keywords.length - 1, 1));
      return { label: rule.label, confidence };
    })
    .filter((topic) => topic.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);

  const timeLabel = extractTimeLabel(`${title}\n${text}`);
  const entities = extractEntities(text);
  const templateSignature = getTemplateSignature(text, title);

  const subtypeByPattern: Array<{ key: string; subtype: string }> = [
    { key: "monthly", subtype: "monthly report" },
    { key: "annual", subtype: "annual record" },
    { key: "reimbursement", subtype: "grant reimbursement backup" },
    { key: "election", subtype: "board election materials" },
    { key: "membership", subtype: "membership form" },
    { key: "donor", subtype: "donor letter" },
    { key: "outreach", subtype: "youth outreach packet" },
    { key: "banquet", subtype: "annual banquet records" },
  ];
  const matchedSubtype = subtypeByPattern.find((candidate) => corpus.includes(candidate.key))?.subtype ?? null;

  const confidenceNarrative: string[] = [
    `likely ${bestType}, ${Math.round(bounded(bestTypeScore + 0.3) * 100)}% confidence`,
  ];
  if (topicLabels.length > 0) {
    const topTopic = topicLabels[0];
    confidenceNarrative.push(`maybe ${topTopic.label}-related, ${Math.round(topTopic.confidence * 100)}% confidence`);
  }
  if (!timeLabel.exactDate && !timeLabel.approximateYear) {
    confidenceNarrative.push("year unclear");
  }

  return {
    documentType: bestType,
    documentTypeConfidence: bounded(bestTypeScore + 0.3),
    topicLabels,
    timeLabel,
    entities,
    canonicalType: bestType === "memo" || bestType === "correspondence" ? "correspondence" : bestType,
    subtype: matchedSubtype,
    templateSignature,
    confidenceNarrative,
  };
}

function computeFuzzySignature(text: string): string[] {
  const grams = [...ngrams(text, 4)];
  return grams.sort().slice(0, 60);
}

async function computeFingerprint(
  text: string,
  title: string,
  filePath: string | null,
): Promise<Fingerprint> {
  const normalized = normalizeText(text);
  const tokens = tokenizeForSimilarity(text);
  const fileHash = filePath
    ? await fs.readFile(filePath).then((buffer) => crypto.createHash("sha256").update(buffer).digest("hex")).catch(() => null)
    : null;

  return {
    exactTextHash: sha256(normalized),
    textLength: text.length,
    tokenCount: tokens.length,
    fuzzySignature: computeFuzzySignature(normalized),
    templateSignature: getTemplateSignature(text, title),
    semanticVector: buildSemanticVector(text),
    fileHash,
  };
}

function extractExistingVector(searchIndex: unknown): number[] {
  if (!searchIndex || typeof searchIndex !== "object") return [];
  const vector = (searchIndex as Record<string, unknown>).embeddingVector;
  if (!Array.isArray(vector)) return [];
  return vector.filter((value): value is number => typeof value === "number");
}

function extractExistingTemplateSignature(classificationResult: unknown): string | null {
  if (!classificationResult || typeof classificationResult !== "object") return null;
  const autoLabels = (classificationResult as Record<string, unknown>).autoLabels;
  if (!autoLabels || typeof autoLabels !== "object") return null;
  const signature = (autoLabels as Record<string, unknown>).templateSignature;
  return typeof signature === "string" ? signature : null;
}

function monthSeriesName(title: string, type: string): string | null {
  const lower = title.toLowerCase();
  const monthlyWords = ["monthly", "month", "mtd"];
  if (!monthlyWords.some((word) => lower.includes(word))) return null;
  const base = lower.replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december|\d{4}|q[1-4])\b/g, "").replace(/\s+/g, " ").trim();
  if (!base) return `${type} monthly series`;
  return `${base} monthly series`;
}

function buildStableTaxonomyKey(auto: AutoLabelingResult): string {
  const topTopic = auto.topicLabels[0]?.label ?? "general";
  const subtype = auto.subtype ?? "general";
  return `${auto.canonicalType}::${subtype}::${topTopic}`;
}

async function compareAgainstExistingDocuments(
  documentId: string,
  title: string,
  extractedText: string,
  month: number | null,
  year: number,
  autoLabels: AutoLabelingResult,
  fingerprint: Fingerprint,
  tenantScope: TenantScope,
): Promise<SimilarityResult> {
  const candidates = await prisma.document.findMany({
    where: {
      organizationId: tenantScope.organizationId,
      programDomain: tenantScope.programDomain,
      id: { not: documentId },
      extractedText: { not: "" },
    },
    orderBy: { updatedAt: "desc" },
    take: 250,
    select: {
      id: true,
      title: true,
      extractedText: true,
      year: true,
      month: true,
      classificationResult: true,
      duplicateCheck: true,
      searchIndex: true,
    },
  });

  const similarTo: Array<{ id: string; score: number; reason: string }> = [];
  const priorVersions: Array<{ id: string; score: number }> = [];
  let duplicateOf: string | null = null;
  let recurringSeriesName: string | null = null;

  const currentGrams = ngrams(extractedText);
  const currentVector = fingerprint.semanticVector;

  for (const candidate of candidates) {
    const candidateDuplicate = (candidate.duplicateCheck && typeof candidate.duplicateCheck === "object"
      ? candidate.duplicateCheck
      : {}) as Record<string, unknown>;
    const candidateFingerprint = candidateDuplicate.fingerprint;
    const candidateTextHash =
      candidateFingerprint &&
      typeof candidateFingerprint === "object" &&
      typeof (candidateFingerprint as Record<string, unknown>).exactTextHash === "string"
        ? (candidateFingerprint as Record<string, unknown>).exactTextHash as string
        : sha256(normalizeText(candidate.extractedText));

    const candidateFileHash =
      candidateFingerprint &&
      typeof candidateFingerprint === "object" &&
      typeof (candidateFingerprint as Record<string, unknown>).fileHash === "string"
        ? (candidateFingerprint as Record<string, unknown>).fileHash as string
        : null;

    if (
      candidateTextHash === fingerprint.exactTextHash ||
      (candidateFileHash && fingerprint.fileHash && candidateFileHash === fingerprint.fileHash)
    ) {
      duplicateOf = candidate.id;
      similarTo.push({ id: candidate.id, score: 1, reason: "exact duplicate hash" });
      continue;
    }

    const fuzzy = jaccard(currentGrams, ngrams(candidate.extractedText));
    const candidateVector = extractExistingVector(candidate.searchIndex);
    const semantic = cosineSimilarity(currentVector, candidateVector.length > 0 ? candidateVector : buildSemanticVector(candidate.extractedText));

    const candidateTemplate = extractExistingTemplateSignature(candidate.classificationResult);
    const sameTemplate = candidateTemplate === fingerprint.templateSignature;

    const weighted = bounded(fuzzy * 0.55 + semantic * 0.45 + (sameTemplate ? 0.1 : 0));

    if (weighted >= 0.65) {
      similarTo.push({
        id: candidate.id,
        score: Number(weighted.toFixed(3)),
        reason: semantic >= fuzzy ? "semantic similarity" : "fuzzy text similarity",
      });
    }

    if (weighted >= 0.72 && sameTemplate) {
      priorVersions.push({ id: candidate.id, score: Number(weighted.toFixed(3)) });
    }

    const series = monthSeriesName(title, autoLabels.documentType);
    if (
      series &&
      candidate.title.toLowerCase().includes(series.replace(/ monthly series$/, "")) &&
      candidate.year <= year &&
      (month === null || candidate.month !== month)
    ) {
      recurringSeriesName = series;
    }
  }

  similarTo.sort((a, b) => b.score - a.score);
  priorVersions.sort((a, b) => b.score - a.score);

  const clusterSeed = duplicateOf ?? similarTo[0]?.id ?? documentId;
  const clusterId = `cluster-${sha256(`${autoLabels.canonicalType}|${clusterSeed}`).slice(0, 12)}`;

  return {
    duplicateOf,
    similarTo: similarTo.slice(0, 10),
    priorVersions: priorVersions.slice(0, 5),
    recurringSeriesName,
    clusterId,
  };
}

async function assignDocumentFamily(
  documentId: string,
  title: string,
  sourceReference: string | null,
  year: number,
  month: number | null,
  autoLabels: AutoLabelingResult,
  tenantScope: TenantScope,
): Promise<FamilyResult> {
  const candidates = await prisma.document.findMany({
    where: {
      organizationId: tenantScope.organizationId,
      programDomain: tenantScope.programDomain,
      id: { not: documentId },
      year: { gte: year - 1, lte: year + 1 },
    },
    orderBy: { updatedAt: "desc" },
    take: 120,
    select: {
      id: true,
      title: true,
      sourceReference: true,
      year: true,
      month: true,
      classificationResult: true,
      extractedMetadata: true,
      searchIndex: true,
    },
  });

  let bestId: string | null = null;
  let bestFamilyId: string | null = null;
  let bestScore = 0;
  let bestReasons: string[] = [];

  for (const candidate of candidates) {
    let score = 0;
    const reasons: string[] = [];

    if (month !== null && candidate.month === month && candidate.year === year) {
      score += 35;
      reasons.push("same month/year");
    }

    if (
      sourceReference &&
      candidate.sourceReference &&
      sourceReference.split("/").slice(0, -1).join("/") === candidate.sourceReference.split("/").slice(0, -1).join("/")
    ) {
      score += 25;
      reasons.push("same source folder");
    }

    const candidateDocType = (() => {
      if (!candidate.classificationResult || typeof candidate.classificationResult !== "object") return "";
      const auto = (candidate.classificationResult as Record<string, unknown>).autoLabels;
      if (!auto || typeof auto !== "object") return "";
      const type = (auto as Record<string, unknown>).documentType;
      return typeof type === "string" ? type : "";
    })();

    const pairKey = `${autoLabels.documentType}|${candidateDocType}`;
    const reversePair = `${candidateDocType}|${autoLabels.documentType}`;
    if (FAMILY_COMPLEMENTS.has(pairKey) || FAMILY_COMPLEMENTS.has(reversePair)) {
      score += 22;
      reasons.push("complementary document pair");
    }

    const titleOverlap = jaccard(new Set(toLowerWords(title)), new Set(toLowerWords(candidate.title)));
    if (titleOverlap >= 0.3) {
      score += 18;
      reasons.push("similar title context");
    }

    const existingFamilyId = (() => {
      if (!candidate.searchIndex || typeof candidate.searchIndex !== "object") return null;
      const relationships = (candidate.searchIndex as Record<string, unknown>).relationships;
      if (!relationships || typeof relationships !== "object") return null;
      const familyId = (relationships as Record<string, unknown>).familyId;
      return typeof familyId === "string" ? familyId : null;
    })();

    if (score > bestScore) {
      bestScore = score;
      bestId = candidate.id;
      bestFamilyId = existingFamilyId;
      bestReasons = reasons;
    }
  }

  if (bestId && bestScore >= 52) {
    return {
      familyId: bestFamilyId ?? `fam-${sha256(bestId).slice(0, 12)}`,
      confidence: Number((bestScore / 100).toFixed(2)),
      rationale: bestReasons,
    };
  }

  return {
    familyId: `fam-${crypto.randomUUID().slice(0, 12)}`,
    confidence: 0.45,
    rationale: ["new logical package candidate"],
  };
}

function buildSearchHelpers(
  title: string,
  text: string,
  tags: string[],
  entities: EntityExtraction,
  autoLabels: AutoLabelingResult,
  fingerprint: Fingerprint,
): Record<string, unknown> {
  const corpus = `${title}\n${text}`.toLowerCase();
  const tokens = tokenizeForSimilarity(`${title} ${text}`);
  const domainKeywords = [
    { keyword: "irs", test: /\birs\b|internal revenue service/i },
    { keyword: "internal revenue service", test: /internal revenue service/i },
    { keyword: "treasury", test: /department of the treasury|\btreasury\b/i },
    { keyword: "tax notice", test: /tax notice|notice date|date of notice/i },
    { keyword: "ein", test: /\bein\b|employer identification number/i },
    { keyword: "employer identification number", test: /employer identification number/i },
    { keyword: "tax filing", test: /tax filing|file your .*tax/i },
    { keyword: "irs correspondence", test: /irs.*(letter|notice|correspondence)|correspondence.*irs/i },
    { keyword: "notice date", test: /notice date|date of notice/i },
  ]
    .filter((entry) => entry.test.test(corpus))
    .map((entry) => entry.keyword);

  const normalizedKeywords = [...new Set([...tokens, ...tags.map((tag) => tag.toLowerCase()), ...domainKeywords])].slice(0, 120);
  const stemmedTerms = [...new Set(normalizedKeywords.map(simpleStem))].slice(0, 120);

  const aliases = [
    ...entities.organizations,
    ...entities.people,
    ...entities.locations,
  ]
    .map((value) => value.toLowerCase())
    .slice(0, 40);

  const notablePhrases = text
    .split(/[.\n]/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 25)
    .slice(0, 6);

  return {
    normalizedKeywords,
    aliases,
    stemmedTerms,
    embeddingVector: fingerprint.semanticVector,
    summaryText: text.slice(0, 500),
    notablePhrases,
    templateSignature: autoLabels.templateSignature,
  };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}

async function resolveStableTaxonomy(
  autoLabels: AutoLabelingResult,
  tenantScope: TenantScope,
): Promise<{ stableCategory: string; confidence: number }> {
  const fallback = buildStableTaxonomyKey(autoLabels);
  const docs = await prisma.document.findMany({
    where: {
      organizationId: tenantScope.organizationId,
      programDomain: tenantScope.programDomain,
    },
    select: { classificationResult: true },
    take: 300,
    orderBy: { updatedAt: "desc" },
  });

  const counts = new Map<string, number>();
  for (const doc of docs) {
    if (!doc.classificationResult || typeof doc.classificationResult !== "object") continue;
    const taxonomy = (doc.classificationResult as Record<string, unknown>).taxonomy;
    if (!taxonomy || typeof taxonomy !== "object") continue;
    const key = (taxonomy as Record<string, unknown>).stableCategory;
    if (typeof key !== "string") continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const matchCount = counts.get(fallback) ?? 0;
  if (matchCount >= 2) {
    return {
      stableCategory: fallback,
      confidence: bounded(0.72 + matchCount * 0.04),
    };
  }

  return {
    stableCategory: fallback,
    confidence: 0.56,
  };
}

// ---------------------------------------------------------------------------
// Quick filename-based intake (synchronous, no I/O)
// Produces a preliminary type prediction from filename + MIME type alone.
// Runs before any file extraction so the UI can show a prediction immediately.
// ---------------------------------------------------------------------------

type QuickIntakeResult = {
  typePrediction: {
    predictedType: string;
    confidence: number;
    confidenceBand: "high" | "medium" | "low";
    sourceName: null;
    pageCount: number;
    firstPageSnippet: string;
    candidates: Array<{ type: string; label: string; confidence: number; reasons: string[] }>;
    layoutHints: string[];
  };
  routeDecision: "auto_extract" | "confirmation_required" | "unknown_waiting_for_type";
};

function runFilenameIntake(
  filename: string | null,
  mimeType: string | null,
  _title: string,
): QuickIntakeResult {
  // Use empty string as text so only filename heuristics fire
  const classification = classifyDocumentType("", filename);

  const layoutHints: string[] = [];
  if (mimeType === "application/pdf") layoutHints.push("pdf");
  else if (mimeType?.startsWith("image/")) layoutHints.push("image_file");
  else if (mimeType?.startsWith("text/")) layoutHints.push("text_file");

  const band: "high" | "medium" | "low" =
    classification.confidence >= 0.78 ? "high"
    : classification.confidence >= 0.52 ? "medium"
    : "low";

  const routeDecision: QuickIntakeResult["routeDecision"] =
    band === "high" ? "auto_extract"
    : classification.documentType === "other_unclassified" ? "unknown_waiting_for_type"
    : "confirmation_required";

  return {
    typePrediction: {
      predictedType: classification.documentType,
      confidence: classification.confidence,
      confidenceBand: band,
      sourceName: null,
      pageCount: 0,
      firstPageSnippet: "",
      candidates: [],
      layoutHints,
    },
    routeDecision,
  };
}

// ---------------------------------------------------------------------------
// Timeout wrapper
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(
      () => reject(new Error(`Processing timed out after ${timeoutMs}ms (${label})`)),
      timeoutMs,
    );
    promise.then(
      (v) => { clearTimeout(id); resolve(v); },
      (e) => { clearTimeout(id); reject(e); },
    );
  });
}

// ---------------------------------------------------------------------------
// Plain text extractor
// ---------------------------------------------------------------------------

async function extractPlainText(filePath: string): Promise<ExtractionResult> {
  const text = await fs.readFile(filePath, "utf8");
  return { text: text.slice(0, 200_000), confidence: 0.98, method: "text" };
}

// ---------------------------------------------------------------------------
// PDF extractor (pdf-parse)
// ---------------------------------------------------------------------------

async function extractPdf(filePath: string): Promise<ExtractionResult> {
  const buffer = await fs.readFile(filePath);
  // Dynamic import keeps pdf-parse out of the module graph until needed.
  // Support both legacy v1 default-function API and v2 class-based API.
  const pdfModule = await import("pdf-parse" as string) as {
    default?: (buf: Buffer) => Promise<{ text: string; numpages: number }>;
    PDFParse?: new (options: { data: Buffer }) => {
      getText: () => Promise<{ text?: string; total?: number }>;
      destroy?: () => Promise<void>;
    };
  };

  let data: { text: string; numpages: number };

  if (typeof pdfModule.default === "function") {
    data = await pdfModule.default(buffer);
  } else if (typeof pdfModule.PDFParse === "function") {
    const parser = new pdfModule.PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      data = {
        text: result.text ?? "",
        numpages: result.total ?? 1,
      };
    } finally {
      await parser.destroy?.();
    }
  } else {
    throw new Error("pdf-parse does not expose a supported parser API");
  }

  const rawText = (data.text || "").trim();
  const wordCount = rawText.split(/\s+/).filter(Boolean).length;
  const pageCount = data.numpages || 1;
  const wordsPerPage = wordCount / pageCount;

  if (wordsPerPage < SCANNED_PDF_WORDS_PER_PAGE_THRESHOLD) {
    return {
      text: rawText,
      confidence: 0.3,
      method: "pdf_scanned",
      pageCount,
      warnings: [
        `PDF appears to be scanned (${Math.round(wordsPerPage)} words/page < threshold ${SCANNED_PDF_WORDS_PER_PAGE_THRESHOLD}).`,
        "Full scanned-PDF OCR requires system-level tools (e.g. poppler). Document flagged for manual review.",
      ],
    };
  }

  return {
    text: rawText.slice(0, 200_000),
    confidence: 0.92,
    method: "pdf",
    pageCount,
  };
}

// ---------------------------------------------------------------------------
// Image OCR extractor (tesseract.js)
// ---------------------------------------------------------------------------

async function extractImage(filePath: string): Promise<ExtractionResult> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");
  try {
    const { data } = await worker.recognize(filePath);
    const confidence = (data.confidence ?? 0) / 100;
    return {
      text: (data.text || "").slice(0, 200_000),
      confidence,
      method: "ocr",
    };
  } finally {
    await worker.terminate();
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

async function runExtraction(
  filePath: string | null,
  mimeType: string | null,
  context?: ExtractionContext,
): Promise<ExtractionResult> {
  if (!filePath) {
    return { text: "", confidence: 0.1, method: "unsupported", warnings: ["No file path"] };
  }

  // File existence + size guard
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) {
    return {
      text: "",
      confidence: 0,
      method: "unsupported",
      warnings: [
        `File not found at path: ${filePath}. The file may have been lost due to ephemeral storage (server restart or deploy). Re-upload the document to reprocess.`,
      ],
    };
  }
  if (stat.size > MAX_FILE_SIZE_BYTES) {
    return {
      text: "",
      confidence: 0.1,
      method: "unsupported",
      warnings: [
        `File size ${stat.size} bytes exceeds processing limit of ${MAX_FILE_SIZE_BYTES} bytes. Manual review required.`,
      ],
    };
  }

  const sharedParserSupportedMimeTypes = new Set([
    "application/pdf",
    "application/json",
    "text/csv",
  ]);

  const canUseSharedParserProvider =
    canUseSharedParser() &&
    (Boolean(mimeType && (mimeType.startsWith("image/") || mimeType.startsWith("text/"))) ||
      sharedParserSupportedMimeTypes.has(mimeType ?? ""));

  if (canUseSharedParserProvider) {
    try {
      logger.info("Shared parser invocation started", {
        provider: getActiveParseProvider(),
        documentId: context?.documentId,
        jobId: context?.jobId,
        mimeType,
        filePath,
      });

      const parsed = await parseDocumentWithSharedService(filePath, {
        documentId: context?.documentId,
        jobId: context?.jobId,
        mimeType,
      });

      const parsedText = parsed.text?.trim() || parsed.markdown?.trim() || "";
      if (parsedText.length > 0) {
        return {
          text: parsedText.slice(0, 200_000),
          confidence: 0.93,
          method: "core_api",
          warnings: [],
        };
      }

      logger.warn("Shared parser returned empty text; falling back to legacy extraction", {
        provider: getActiveParseProvider(),
        documentId: context?.documentId,
        jobId: context?.jobId,
        mimeType,
      });
    } catch (error) {
      logger.warn("Shared parser failed; falling back to legacy extraction", {
        provider: getActiveParseProvider(),
        documentId: context?.documentId,
        jobId: context?.jobId,
        mimeType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (mimeType === "application/pdf") return extractPdf(filePath);
  if (mimeType?.startsWith("image/")) return extractImage(filePath);
  if (
    mimeType?.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "text/csv"
  ) {
    return extractPlainText(filePath);
  }

  // Provide helpful messages for common unsupported formats
  const unsupportedFormatWarnings: string[] = [];
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    unsupportedFormatWarnings.push(
      "DOCX extraction not yet supported. Workaround: Convert to PDF or export as text and re-upload."
    );
  } else if (mimeType?.includes("microsoft")) {
    unsupportedFormatWarnings.push(
      `Microsoft Office format (.${mimeType.split("/")[1]}) not yet supported. Please convert to PDF and re-upload.`
    );
  } else if (mimeType?.includes("spreadsheet") || mimeType?.includes("excel")) {
    unsupportedFormatWarnings.push(
      "Spreadsheet format not supported. Please export as CSV or PDF and re-upload."
    );
  } else if (mimeType?.includes("presentation")) {
    unsupportedFormatWarnings.push(
      "Presentation format not supported. Please export as PDF and re-upload."
    );
  } else {
    unsupportedFormatWarnings.push(`No extractor available for MIME type: ${mimeType || "unknown"}`);
  }

  return {
    text: "",
    confidence: 0.1,
    method: "unsupported" as const,
    warnings: unsupportedFormatWarnings,
  };
}

// ---------------------------------------------------------------------------
// JSON helper – strips class prototypes so Prisma accepts the value as plain JSON
// ---------------------------------------------------------------------------

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

// ---------------------------------------------------------------------------
// History helper
// ---------------------------------------------------------------------------

function appendHistory(existing: unknown, event: Record<string, unknown>) {
  const history = Array.isArray(existing) ? [...existing] : [];
  history.push(event);
  return toPrismaJson(history);
}

// ---------------------------------------------------------------------------
// Failure handler — retry with backoff or dead-letter
// ---------------------------------------------------------------------------

async function handleJobFailure(
  job: {
    id: string;
    documentId: string;
    attempts: number;
    maxAttempts: number;
    errorLog: unknown;
    document: { processingHistory: unknown; title: string; author: string };
  },
  error: Error,
): Promise<void> {
  const errorEntry = {
    attempt: job.attempts,
    timestamp: new Date().toISOString(),
    error: error.message,
  };
  const errorLog = [
    ...(Array.isArray(job.errorLog) ? job.errorLog : []),
    errorEntry,
  ];

  const isDeadLetter = job.attempts >= job.maxAttempts;

  if (isDeadLetter) {
    logger.error("Job permanently failed — dead-lettered", {
      jobId: job.id,
      documentId: job.documentId,
      attempts: job.attempts,
      error: error.message,
    });

    await prisma.processingJob.update({
      where: { id: job.id },
      data: {
        status: "dead_letter",
        error: error.message,
        errorLog,
        completedAt: new Date(),
      } as never,
    });

    await prisma.document.update({
      where: { id: job.documentId },
      data: {
        processingStatus: "failed",
        ocrStatus: "failed",
        status: "failed",
        statusUpdatedAt: new Date(),
        needsReview: true,
        review: {
          required: true,
          reason: ["Processing permanently failed after maximum retries"],
          priority: "high",
        },
        extraction: {
          status: "failed",
          errorMessage: error.message,
          extractedAt: new Date().toISOString(),
        },
        processingHistory: appendHistory(job.document.processingHistory, {
          timestamp: new Date().toISOString(),
          action: "dead_letter",
          status: "failed",
          details: `Permanently failed after ${job.attempts} attempt(s): ${error.message}`,
        }),
      },
    });
  } else {
    // Exponential backoff: attempt 1 → 5s, attempt 2 → 10s, attempt 3 → 20s
    const backoffMs = RETRY_BACKOFF_BASE_MS * Math.pow(2, job.attempts - 1);
    const nextRetryAt = new Date(Date.now() + backoffMs);

    logger.warn("Job failed — scheduling retry", {
      jobId: job.id,
      documentId: job.documentId,
      attempt: job.attempts,
      maxAttempts: job.maxAttempts,
      nextRetryAt: nextRetryAt.toISOString(),
      error: error.message,
    });

    await prisma.processingJob.update({
      where: { id: job.id },
      data: {
        status: "queued",
        scheduledAt: nextRetryAt,
        nextRetryAt,
        error: error.message,
        errorLog,
      } as never,
    });

    await prisma.document.update({
      where: { id: job.documentId },
      data: {
        processingStatus: "queued",
        ocrStatus: "pending",
        status: "queued",
        statusUpdatedAt: new Date(),
        processingHistory: appendHistory(job.document.processingHistory, {
          timestamp: new Date().toISOString(),
          action: "retry_scheduled",
          status: "queued",
          details: `Attempt ${job.attempts} failed. Retry ${job.attempts + 1} scheduled at ${nextRetryAt.toISOString()}.`,
        }),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Core job processor
// ---------------------------------------------------------------------------

async function processSingleJob(): Promise<void> {
  const job = await prisma.processingJob.findFirst({
    where: {
      status: "queued",
      scheduledAt: { lte: new Date() },
    },
    orderBy: { createdAt: "asc" },
    include: { document: true },
  });

  if (!job) return;

  // Mark as processing immediately to prevent duplicate pickup
  await prisma.processingJob.update({
    where: { id: job.id },
    data: {
      status: "processing",
      startedAt: new Date(),
      attempts: { increment: 1 },
    },
  });

  // Re-fetch after increment so we have the current attempt count + errorLog
  const updatedJob = await prisma.processingJob.findUniqueOrThrow({
    where: { id: job.id },
    include: { document: true },
  });
  const tenantScope: TenantScope = {
    organizationId: updatedJob.organizationId,
    programDomain: updatedJob.programDomain,
  };
  const existingExtractionMeta =
    updatedJob.document.extraction && typeof updatedJob.document.extraction === "object"
      ? (updatedJob.document.extraction as Record<string, unknown>)
      : {};
  const forcedDocumentType =
    typeof existingExtractionMeta.forcedDocumentType === "string" && existingExtractionMeta.forcedDocumentType.trim().length > 0
      ? existingExtractionMeta.forcedDocumentType.trim()
      : null;

  // ── Quick filename-based intake (synchronous, no I/O) ─────────────────────
  // Runs before heavy file-extraction so the UI immediately shows a preliminary
  // prediction.  The full pipeline will overwrite typePrediction with richer
  // data once extracted text is available.
  const filenameIntake = runFilenameIntake(
    updatedJob.document.originalFileName,
    updatedJob.document.mimeType,
    updatedJob.document.title,
  );
  // If the filename alone gives a high-confidence signal, write canonical
  // type/review fields immediately so list views can reflect intake routing.
  const earlyTypeFields: Record<string, unknown> = filenameIntake.typePrediction.confidence >= 0.78
    ? {
        type: filenameIntake.typePrediction.predictedType,
        classificationStatus: "known",
        classificationMatchedBy: "rule",
        classificationConfidence: filenameIntake.typePrediction.confidence,
        needsReview: false,
      }
    : {};

  await prisma.document.update({
    where: { id: job.documentId },
    data: {
      processingStatus: "intake_complete",
      ocrStatus: "in_progress",
      status: "extracting",
      statusUpdatedAt: new Date(),
      ...earlyTypeFields,
      processingHistory: appendHistory(job.document.processingHistory, {
        timestamp: new Date().toISOString(),
        action: "intake_complete",
        status: "intake_complete",
        details: `Processing started (attempt ${updatedJob.attempts}). Quick intake: predicted '${filenameIntake.typePrediction.predictedType}' (${Math.round(filenameIntake.typePrediction.confidence * 100)}%, ${filenameIntake.typePrediction.confidenceBand}). Route: ${filenameIntake.routeDecision}.`,
        quickIntake: filenameIntake.typePrediction,
        routeDecision: filenameIntake.routeDecision,
      }),
      extraction: {
        ...existingExtractionMeta,
        status: "intake_complete",
        typePrediction: filenameIntake.typePrediction,
        routeDecision: filenameIntake.routeDecision,
        intakeTimestamp: new Date().toISOString(),
      },
    } as never,
  });

  logger.info("Processing job started", {
    jobId: job.id,
    documentId: job.documentId,
    attempt: updatedJob.attempts,
    mimeType: job.document.mimeType,
  });

  // If the file is stored in R2, download it to a temp path for extraction.
  // The temp file is cleaned up in the finally block regardless of outcome.
  let extractionFilePath = job.document.filePath;
  let tempFilePath: string | null = null;

  if (extractionFilePath && isR2Configured() && isR2Key(extractionFilePath)) {
    const ext = path.extname(extractionFilePath) || "";
    tempFilePath = path.join(os.tmpdir(), `processing-${job.id}${ext}`);
    logger.info("Downloading file from R2 for processing", {
      jobId: job.id,
      key: extractionFilePath,
      tempPath: tempFilePath,
    });
    const buffer = await downloadFromR2(extractionFilePath);
    await fs.writeFile(tempFilePath, buffer);
    extractionFilePath = tempFilePath;
  }

  try {
    const extraction = await withTimeout(
      runExtraction(extractionFilePath, job.document.mimeType, {
        documentId: job.documentId,
        jobId: job.id,
      }),
      JOB_TIMEOUT_MS,
      job.document.mimeType ?? "unknown",
    );

    const nowIso = new Date().toISOString();
    const docRecord = job.document as unknown as Record<string, unknown>;
    const baseText =
      extraction.text ||
      `${job.document.title}\n\n${typeof docRecord.description === "string" ? docRecord.description : ""}`;

    // ─────────────────────────────────────────────────────────────────────
    // Llama Cloud AI Classification — runs after extraction, before rule-based
    // Only attempted when file is accessible and extraction was not unsupported
    // ─────────────────────────────────────────────────────────────────────
    let aiClassResult: ChronicleClassificationResult | null = null;
    if (extraction.method !== "unsupported" && extractionFilePath) {
      try {
        aiClassResult = await classifyDocumentWithCoreApi(
          extractionFilePath,
          job.document.mimeType ?? null,
          { documentId: job.documentId, jobId: job.id },
        );
      } catch (classifyErr) {
        logger.warn("Core API classify — unexpected error (non-fatal)", {
          jobId: job.id,
          documentId: job.documentId,
          error: classifyErr instanceof Error ? classifyErr.message : String(classifyErr),
        });
      }
    }

    const autoLabels = classifyDocumentTypeAndTopics(job.document.title, baseText);
    // Pass extractionFilePath (the resolved local/temp path) so computeFingerprint
    // can read the file bytes for the exact file hash. For R2-backed documents,
    // job.document.filePath is the R2 object key (not a local path), so using it
    // directly would silently produce fileHash=null for every R2 file.
    const fingerprint = await computeFingerprint(baseText, job.document.title, extractionFilePath);
    const similarity = await compareAgainstExistingDocuments(
      job.documentId,
      job.document.title,
      baseText,
      job.document.month,
      job.document.year,
      autoLabels,
      fingerprint,
      tenantScope,
    );
    const family = await assignDocumentFamily(
      job.documentId,
      job.document.title,
      job.document.sourceReference,
      job.document.year,
      job.document.month,
      autoLabels,
      tenantScope,
    );
    const taxonomy = await resolveStableTaxonomy(autoLabels, tenantScope);

    const existingTags = asStringArray(job.document.tags);
    const topicTags = autoLabels.topicLabels.map((topic) => topic.label);
    const taxSpecificTags = [
      { tag: "irs", test: /\birs\b|internal revenue service/i },
      { tag: "internal revenue service", test: /internal revenue service/i },
      { tag: "treasury", test: /department of the treasury|\btreasury\b/i },
      { tag: "ein", test: /\bein\b|employer identification number/i },
      { tag: "employer identification number", test: /employer identification number/i },
      { tag: "tax notice", test: /tax notice|notice date|date of notice/i },
      { tag: "irs correspondence", test: /correspondence.*irs|irs.*correspondence|irs.*notice/i },
    ]
      .filter((entry) => entry.test.test(baseText))
      .map((entry) => entry.tag);
    const entityTags = [
      ...autoLabels.entities.organizations,
      ...autoLabels.entities.locations,
    ].map((value) => value.toLowerCase());
    const mergedTags = [...new Set([...existingTags, ...topicTags, ...taxSpecificTags, ...entityTags])].slice(0, 60);

    const suggestedYear = autoLabels.timeLabel.approximateYear;
    const finalYear = suggestedYear ?? job.document.year;
    const finalMonth = job.document.month;

    // ─────────────────────────────────────────────────────────────────────
    // Extraction Quality Assessment — separate extraction from classification
    // ─────────────────────────────────────────────────────────────────────
    const extractedWordCount = baseText ? baseText.split(/\s+/).filter(Boolean).length : 0;
    const isTitleOnlyExtraction = extractedWordCount < 20 && extraction.method !== "unsupported";
    const isNoContentExtraction = extractedWordCount === 0;

    // Determine extraction quality status
    let extractionQuality: "full_extraction" | "partial_extraction" | "minimal_extraction" | "unsupported_format" | "no_extraction" = "full_extraction";
    if (extraction.method === "unsupported") {
      extractionQuality = "unsupported_format";
    } else if (isNoContentExtraction) {
      extractionQuality = "no_extraction";
    } else if (isTitleOnlyExtraction) {
      extractionQuality = "minimal_extraction";
    } else if (extractedWordCount < 100) {
      extractionQuality = "partial_extraction";
    }

    // ─────────────────────────────────────────────────────────────────────
    // Review Necessity Logic — STRICT rules for unsupported/low-confidence
    // ─────────────────────────────────────────────────────────────────────
    // Rule 1: ALWAYS review unsupported file formats
    // Rule 2: ALWAYS review when no real extraction happened
    // Rule 3: ALWAYS review when minimal/partial extraction with low confidence
    // Rule 4: Never auto-approve low confidence + weak classification
    
    const autoApprovalThreshold = 0.8;
    const classificationThreshold = 0.8;

    // Determine the best document type: prefer Llama classify when it is confident
    const aiDocumentType =
      aiClassResult?.status === "complete" && aiClassResult.decision === "auto_accepted"
        ? aiClassResult.documentType
        : null;
    const finalDocumentType = forcedDocumentType ?? aiDocumentType ?? autoLabels.documentType;

    // Llama classify forces review when it returned needs_review or failed on a supported format
    const aiForcesReview =
      aiClassResult !== null &&
      (aiClassResult.status === "failed" ||
        aiClassResult.decision === "needs_review" ||
        aiClassResult.decision === "low_confidence");

    const needsReview =
      extraction.method === "unsupported" || // Rule 1: unsupported formats always need review
      isNoContentExtraction || // Rule 2: no content = always review
      isTitleOnlyExtraction || // Rule 3: title-only always needs review
      aiForcesReview || // Rule 5: AI classify low-confidence or failed
      extraction.confidence < OCR_CONFIDENCE_REVIEW_THRESHOLD ||
      autoLabels.documentTypeConfidence < classificationThreshold ||
      autoLabels.topicLabels.length === 0 ||
      autoLabels.timeLabel.confidence < 0.6;

    // Rule 4: Never auto-approve if extraction quality is questionable
    // Only auto-approve if BOTH extraction AND Llama classification are highly confident
    const aiAutoAccepted =
      aiClassResult?.status === "complete" &&
      aiClassResult.decision === "auto_accepted" &&
      (aiClassResult.confidence ?? 0) >= LLAMA_CLASSIFY_AUTO_ACCEPT_THRESHOLD;

    const canAutoApprove =
      extractionQuality === "full_extraction" &&
      extraction.confidence >= autoApprovalThreshold &&
      (aiAutoAccepted || autoLabels.documentTypeConfidence >= classificationThreshold) &&
      extractedWordCount >= 500;

    const reviewReasons: string[] = [];
    
    // Add format/extraction-specific reasons first
    if (extraction.method === "unsupported") {
      const fileExt = job.document.originalFileName ? job.document.originalFileName.split(".").pop()?.toUpperCase() : "unknown";
      reviewReasons.push(`⚠️ Unsupported file format (.${fileExt})`);
      if (fileExt === "DOCX") {
        reviewReasons.push("💡 DOCX extraction is not yet supported. Please re-upload as PDF or extract text manually.");
      } else {
        reviewReasons.push(`💡 No extractor available for .${fileExt} files.`);
      }
      reviewReasons.push("Status: Extraction failed — no content parsed");
    }
    
    if (extraction.method === "pdf_scanned") {
      reviewReasons.push("Scanned PDF detected — manual OCR review required");
    }
    
    if (isNoContentExtraction) {
      reviewReasons.push("No content extracted. Only filename/metadata available.");
    }
    
    if (isTitleOnlyExtraction) {
      reviewReasons.push(`Minimal extraction: ${extractedWordCount} words detected (usually title only)`);
    }
    
    if (extraction.confidence < OCR_CONFIDENCE_REVIEW_THRESHOLD && extraction.method !== "unsupported") {
      reviewReasons.push(`Low extraction confidence (${Math.round(extraction.confidence * 100)}%)`);
    }
    
    if (autoLabels.documentTypeConfidence < classificationThreshold) {
      reviewReasons.push(
        `Weak classification: likely ${autoLabels.documentType} (${Math.round(autoLabels.documentTypeConfidence * 100)}% confidence)`,
      );
    }
    
    if (autoLabels.topicLabels.length === 0) {
      reviewReasons.push("No topic labels detected — document category unclear");
    } else if (autoLabels.topicLabels[0] && autoLabels.topicLabels[0].confidence < classificationThreshold) {
      reviewReasons.push(
        `Weak topic confidence: maybe ${autoLabels.topicLabels[0].label} (${Math.round(autoLabels.topicLabels[0].confidence * 100)}%)`,
      );
    }
    
    if (autoLabels.timeLabel.confidence < 0.6) {
      reviewReasons.push("Date/year unclear — manual verification needed");
    }
    
    if (aiForcesReview && aiClassResult) {
      if (aiClassResult.status === "failed") {
        reviewReasons.push("AI classification step failed — manual type verification required");
      } else if (aiClassResult.decision === "needs_review") {
        reviewReasons.push(
          `AI classification uncertain: ${aiClassResult.documentType} (${Math.round((aiClassResult.confidence ?? 0) * 100)}% confidence)`,
        );
      } else if (aiClassResult.decision === "low_confidence") {
        reviewReasons.push(
          `AI classification low confidence (${Math.round((aiClassResult.confidence ?? 0) * 100)}%) — document type unclear`,
        );
      }
    }

    if (similarity.similarTo.length > 0) {
      reviewReasons.push("⚠️ Similar documents found — verify relationships and deduplication");
    }

    // ─────────────────────────────────────────────────────────────────────
    // Lightweight metadata extraction (Phase 2 — search-first model)
    // Runs on every document regardless of file type or extraction quality.
    // ─────────────────────────────────────────────────────────────────────
    // Fetch any learned type fingerprints for this tenant so classification
    // can benefit from admin-reviewed custom types.
    let typeFingerprints: Array<{ key: string; phrases: string[]; companies: string[] }> = [];
    try {
      const fpRows = await prisma.chronicleTypeFingerprint.findMany({
        where: {
          documentType: {
            organizationId: tenantScope.organizationId,
            programDomain: tenantScope.programDomain,
            active: true,
          },
        },
        include: { documentType: { select: { key: true } } },
      });
      typeFingerprints = fpRows.map((fp) => ({
        key: fp.documentType.key,
        phrases: Array.isArray(fp.phrases) ? (fp.phrases as string[]) : [],
        companies: Array.isArray(fp.companies) ? (fp.companies as string[]) : [],
      }));
    } catch {
      // Non-fatal: fingerprint table may not exist yet (migration pending)
    }

    const stepOne = extractStepOneIntakeMetadata({
      text: baseText,
      filename: job.document.originalFileName ?? null,
      documentId: job.documentId,
      fingerprintTypes: typeFingerprints,
    });
    const lightMeta = stepOne.lightweight;
    const lightClassificationRaw = stepOne.classification;
    const lightClassification = forcedDocumentType
      ? {
          documentType: forcedDocumentType,
          confidence: Math.max(0.9, lightClassificationRaw.confidence),
          classificationStatus: "known" as const,
          classificationMatchedBy: "manual" as const,
        }
      : lightClassificationRaw;

    const stepOneMetadata = forcedDocumentType
      ? {
          ...stepOne.metadata,
          documentType: {
            value: forcedDocumentType,
            confidence: Math.max(0.9, stepOne.metadata.documentType.confidence),
            source: ["manual" as const],
          },
        }
      : stepOne.metadata;

    // Determine whether this document needs review based on new classification
    const lightReviewRequired =
      (!forcedDocumentType && lightClassification.classificationStatus === "other_unclassified") ||
      (!forcedDocumentType && lightClassification.confidence < 0.4);

    // Route decision — persisted in extraction so the UI can show why the
    // document went to its current state and what the user should do next.
    const finalRouteDecision: "auto_extract" | "confirmation_required" | "generic_fallback" | "manual_override" | "unknown_waiting_for_type" =
      forcedDocumentType ? "manual_override"
      : !needsReview && canAutoApprove ? "auto_extract"
      : lightClassification.classificationStatus === "other_unclassified" ? "unknown_waiting_for_type"
      : lightReviewRequired ? "confirmation_required"
      : needsReview ? "confirmation_required"
      : "generic_fallback";

    const searchHelpers = buildSearchHelpers(
      job.document.title,
      baseText,
      mergedTags,
      autoLabels.entities,
      autoLabels,
      fingerprint,
    );

    // Determine review priority based on extraction/classification quality
    let reviewPriority: "critical" | "high" | "medium" | "low" = "medium";
    if (extraction.method === "unsupported" || isNoContentExtraction) {
      reviewPriority = "critical";
    } else if (isTitleOnlyExtraction || extraction.confidence < 0.5) {
      reviewPriority = "high";
    } else if (extraction.confidence < OCR_CONFIDENCE_REVIEW_THRESHOLD) {
      reviewPriority = "medium";
    } else {
      reviewPriority = "low";
    }

    // Determine OCR/extraction status based on quality assessment
    let ocrStatus: string;
    if (extraction.method === "unsupported") {
      ocrStatus = "unsupported";
    } else if (isNoContentExtraction) {
      ocrStatus = "failed";
    } else if (extractionQuality === "partial_extraction" || extractionQuality === "minimal_extraction") {
      ocrStatus = "partial";
    } else {
      ocrStatus = "completed";
    }

    await prisma.document.update({
      where: { id: job.documentId },
      data: {
        extractedText: baseText,
        year: finalYear,
        month: finalMonth,
        type: finalDocumentType,
        tags: mergedTags,
        keywords: (searchHelpers.normalizedKeywords as string[]).slice(0, 80),
        processingStatus: "processed",
        ocrStatus,
        status: needsReview ? "review_required" : (canAutoApprove ? "archived" : "review_required"),
        statusUpdatedAt: new Date(),
        needsReview,
        review: needsReview
          ? {
              required: true,
              extractionQuality,
              reason: [...reviewReasons, ...(extraction.warnings ?? [])],
              priority: reviewPriority,
              suggestions: autoLabels.confidenceNarrative,
              canAutoApprove: false,
            }
          : { required: false, canAutoApprove },
        extraction: {
          ...existingExtractionMeta,
          status: "complete",
          method: extraction.method,
          confidence: extraction.confidence,
          extractionQuality, // New field: tracks extraction quality separate from confidence
          extractedAt: nowIso,
          pageCount: extraction.pageCount ?? null,
          warningMessages: extraction.warnings ?? [],
          contentLength: extractedWordCount,
          documentType: finalDocumentType,
          classificationConfidence: lightClassification.confidence,
          forcedDocumentType: forcedDocumentType ?? undefined,
          // routeDecision: final semantics after full extraction + classification
          routeDecision: finalRouteDecision,
          // Upgrade typePrediction with real extraction data
          typePrediction: {
            predictedType: finalDocumentType,
            confidence: lightClassification.confidence,
            confidenceBand:
              lightClassification.confidence >= 0.78 ? "high"
              : lightClassification.confidence >= 0.52 ? "medium"
              : "low",
            sourceName: stepOneMetadata.organization.name ?? null,
            pageCount: extraction.pageCount ?? 0,
            firstPageSnippet: baseText.slice(0, 2500),
            candidates: [],
            layoutHints: (existingExtractionMeta.typePrediction as Record<string, unknown> | undefined)
              ? ((existingExtractionMeta.typePrediction as Record<string, unknown>).layoutHints as string[] | undefined) ?? []
              : [],
          },
        },
        extractedMetadata: toPrismaJson({
          wordCount: extractedWordCount,
          detectedTitle: job.document.title,
          detectedAuthor: job.document.author,
          detectedDate: autoLabels.timeLabel.exactDate,
          detectedOrganization: autoLabels.entities.organizations[0] ?? null,
          autoTopics: autoLabels.topicLabels,
          entities: autoLabels.entities,
          timeLabel: autoLabels.timeLabel,
          stepOne: stepOneMetadata,
        }),
        classificationResult: toPrismaJson({
          method: aiDocumentType ? "ai_assisted" : "rule_based",
          confidence: aiDocumentType
            ? Number((aiClassResult?.confidence ?? autoLabels.documentTypeConfidence).toFixed(3))
            : Number(autoLabels.documentTypeConfidence.toFixed(3)),
          category: autoLabels.canonicalType,
          provider: aiClassResult?.provider ?? "rule-based",
          decision: aiClassResult?.decision ?? null,
          documentType: aiDocumentType ?? autoLabels.documentType,
          reasoning: aiClassResult?.reasoning ?? null,
          suggestedTags: topicTags,
          autoLabels,
          taxonomy: {
            stableCategory: taxonomy.stableCategory,
            confidence: taxonomy.confidence,
            learned: taxonomy.confidence >= 0.7,
          },
          coreApi: aiClassResult ?? undefined,
          llamaCloud: undefined,
        }),
        duplicateCheck: toPrismaJson({
          hash: fingerprint.fileHash,
          duplicateStatus: similarity.duplicateOf ? "possible_duplicate" : "unique",
          checkedAt: nowIso,
          possibleDuplicateIds: similarity.similarTo.map((item) => item.id),
          duplicateOf: similarity.duplicateOf,
          fingerprint,
        }),
        searchIndex: toPrismaJson({
          ...searchHelpers,
          stepOne: {
            organizationName: stepOneMetadata.organization.name,
            documentType: stepOneMetadata.documentType.value,
            documentDate: stepOneMetadata.documentDate,
            people: stepOneMetadata.people,
            headerText: stepOneMetadata.headerText,
            searchTextSeed: stepOne.searchTextSeed,
            classificationVersion: stepOneMetadata.classificationVersion,
          },
          relationships: {
            duplicateOf: similarity.duplicateOf,
            similarTo: similarity.similarTo,
            familyId: family.familyId,
            clusterId: similarity.clusterId,
            recurringSeriesName: similarity.recurringSeriesName,
            priorVersions: similarity.priorVersions,
            familyConfidence: family.confidence,
            familyRationale: family.rationale,
          },
        }),
        processingHistory: appendHistory(job.document.processingHistory, {
          timestamp: nowIso,
          action: "processing_complete",
          status: "processed",
          extractionQuality,
          ocrStatus,
          requiresReview: needsReview,
          details:
            extraction.method === "unsupported"
              ? `Processing failed: '${extraction.method}' file format not supported`
              : `Processed via '${extraction.method}' extraction (extracted ${extractedWordCount} words, confidence ${Math.round(extraction.confidence * 100)}%). ` +
                (forcedDocumentType
                  ? `Manual override enforced type '${forcedDocumentType}'.`
                  : aiDocumentType
                    ? `AI classified as '${aiDocumentType}' (${Math.round((aiClassResult?.confidence ?? 0) * 100)}% confidence via Core API).`
                    : `Auto-labeled as '${autoLabels.documentType}' (${Math.round(autoLabels.documentTypeConfidence * 100)}% confidence via rule-based).`),
          aiClassification: aiClassResult ?? undefined,
          lightweightDocumentType: lightClassification.documentType,
          lightweightConfidence: lightClassification.confidence,
        }),
        // ── Lightweight metadata fields (search-first model) ─────────────
        sourceName: stepOneMetadata.organization.name ?? lightMeta.sourceName,
        documentDate: stepOneMetadata.documentDate.exactDate ?? lightMeta.documentDate,
        metaPeople: toPrismaJson(stepOneMetadata.people.map((p) => p.name)),
        metaCompanies: toPrismaJson(lightMeta.companies),
        metaLocations: toPrismaJson(lightMeta.locations),
        metaReferenceNumbers: toPrismaJson(lightMeta.referenceNumbers),
        metaOther: toPrismaJson([
          ...lightMeta.other,
          ...stepOneMetadata.people.map((p) => `${p.role}:${p.name}`),
        ]),
        classificationStatus: lightClassification.classificationStatus,
        classificationMatchedBy: lightClassification.classificationMatchedBy,
        classificationConfidence: lightClassification.confidence,
      },
    });

    await prisma.processingJob.update({
      where: { id: job.id },
      data: { status: "completed", completedAt: new Date(), error: null },
    });

    logger.info("Processing job completed", {
      jobId: job.id,
      documentId: job.documentId,
      method: extraction.method,
      confidence: extraction.confidence,
      extractionQuality,
      ocrStatus,
      contentLength: extractedWordCount,
      needsReview,
      reviewPriority,
      aiClassifyStatus: aiClassResult?.status ?? "not_run",
      aiDocumentType: aiClassResult?.documentType ?? null,
      aiConfidence: aiClassResult?.confidence ?? null,
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    await handleJobFailure(
      {
        ...updatedJob,
        maxAttempts:
          (updatedJob as typeof updatedJob & { maxAttempts?: number }).maxAttempts ??
          MAX_ATTEMPTS,
        errorLog:
          (updatedJob as typeof updatedJob & { errorLog?: unknown }).errorLog ?? null,
      },
      err,
    );
  } finally {
    // Always remove the R2 temp file, success or failure
    if (tempFilePath) {
      await fs.unlink(tempFilePath).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Worker loop
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;
  workerLastTickAt = new Date().toISOString();
  try {
    await processSingleJob();
  } catch (err) {
    logger.error("Unexpected error in processing worker tick", {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    workerRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function enqueueProcessing(
  documentId: string,
  tenantScope: TenantScope,
  options?: { maxAttempts?: number; delayMs?: number },
): Promise<void> {
  const scheduledAt = options?.delayMs
    ? new Date(Date.now() + options.delayMs)
    : new Date();
  await prisma.processingJob.create({
    data: {
      documentId,
      organizationId: tenantScope.organizationId,
      programDomain: tenantScope.programDomain,
      status: "queued",
      scheduledAt,
      maxAttempts: options?.maxAttempts ?? MAX_ATTEMPTS,
    } as never,
  });
}

export function startProcessingWorker(intervalMs = 2000): void {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    void tick();
  }, intervalMs);
  logger.info("Processing worker started", { intervalMs });
}

export function stopProcessingWorker(): void {
  if (!workerTimer) return;
  clearInterval(workerTimer);
  workerTimer = null;
  logger.info("Processing worker stopped");
}

export function getProcessingWorkerState(): {
  started: boolean;
  busy: boolean;
  lastTickAt: string | null;
} {
  return {
    started: Boolean(workerTimer),
    busy: workerRunning,
    lastTickAt: workerLastTickAt,
  };
}

// Exported for tests
export { processSingleJob, handleJobFailure, runExtraction };
