import crypto from "crypto";

export interface PageNumberCue {
  page: number;
  total?: number;
}

export interface PdfPageFeature {
  pageIndex: number;
  topLines: string[];
  bottomLines: string[];
  headerTitle: string | null;
  identifierTokens: string[];
  pageNumberCue: PageNumberCue | null;
  templateSignature: string;
  layoutHints: string[];
}

export type BoundaryDecision = "continue" | "split" | "uncertain";

export interface PdfBoundaryDecision {
  leftPageIndex: number;
  rightPageIndex: number;
  continuationScore: number;
  boundaryScore: number;
  confidence: number;
  decision: BoundaryDecision;
  reasons: string[];
  evidence: Record<string, unknown>;
}

export interface ProposedPageSegment {
  startPage: number;
  endPage: number;
  confidence: number;
  reason: string;
}

const MAX_FEATURE_LINES = 4;

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeForSignature(value: string): string {
  return normalizeLine(value)
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/[^a-z0-9#\s]/g, "");
}

function toLineArray(text: string): string[] {
  return text
    .split(/\r?\n+/)
    .map(normalizeLine)
    .filter(Boolean);
}

function hashTemplate(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 20);
}

function parsePageNumberCue(text: string): PageNumberCue | null {
  const normalized = text.toLowerCase();
  const pageOfTotal = normalized.match(/\bpage\s*(\d{1,4})\s*(?:of|\/|\\)\s*(\d{1,4})\b/i);
  if (pageOfTotal) {
    return { page: Number(pageOfTotal[1]), total: Number(pageOfTotal[2]) };
  }

  const pageOnly = normalized.match(/\bpage\s*(\d{1,4})\b/i);
  if (pageOnly) {
    return { page: Number(pageOnly[1]) };
  }

  return null;
}

function extractIdentifierTokens(text: string): string[] {
  const patterns = [
    /\b(?:invoice|inv)[\s:#-]*([a-z0-9-]{4,})\b/gi,
    /\b(?:account|acct)[\s:#-]*([a-z0-9-]{4,})\b/gi,
    /\b(?:reference|ref|file)[\s:#-]*([a-z0-9-]{4,})\b/gi,
    /\b(?:check|cheque)[\s:#-]*([a-z0-9-]{3,})\b/gi,
    /\b(?:statement\s*period|period)[\s:#-]*([a-z0-9\-/]{4,})\b/gi,
  ];

  const out = new Set<string>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const token = (match[1] || "").toLowerCase().trim();
      if (token.length >= 4) out.add(token);
    }
  }
  return [...out].slice(0, 30);
}

function headerRestartCandidate(header: string | null): boolean {
  if (!header) return false;
  return /\b(invoice|statement|letter|receipt|notice|form|check|memo|subject)\b/i.test(header);
}

function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let overlap = 0;
  for (const token of setA) {
    if (setB.has(token)) overlap += 1;
  }
  return overlap / (setA.size + setB.size - overlap);
}

function bounded(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function buildPdfPageFeatures(pageTexts: string[]): PdfPageFeature[] {
  return pageTexts.map((rawText, idx) => {
    const lines = toLineArray(rawText);
    const topLines = lines.slice(0, MAX_FEATURE_LINES);
    const bottomLines = lines.slice(Math.max(0, lines.length - MAX_FEATURE_LINES));
    const headerTitle = topLines[0] || null;
    const identifierTokens = extractIdentifierTokens(rawText);
    const pageNumberCue = parsePageNumberCue(rawText);

    const signatureSeed = [
      ...topLines.map(normalizeForSignature),
      ...bottomLines.map(normalizeForSignature),
    ].join("|");

    const layoutHints: string[] = [];
    if (/\bdear\b/i.test(rawText)) layoutHints.push("letter_like");
    if (/\bqty\b|\bunit price\b|\bsubtotal\b/i.test(rawText)) layoutHints.push("table_financial");
    if (/\bpay to the order of\b|\brouting number\b/i.test(rawText)) layoutHints.push("check_like");
    if (/\bsignature\b|\bdate\s*signed\b/i.test(rawText)) layoutHints.push("form_like");

    return {
      pageIndex: idx + 1,
      topLines,
      bottomLines,
      headerTitle,
      identifierTokens,
      pageNumberCue,
      templateSignature: hashTemplate(signatureSeed),
      layoutHints,
    };
  });
}

export function scorePdfBoundaries(features: PdfPageFeature[]): PdfBoundaryDecision[] {
  const decisions: PdfBoundaryDecision[] = [];
  for (let i = 0; i < features.length - 1; i += 1) {
    const left = features[i];
    const right = features[i + 1];

    let continuationScore = 0;
    let boundaryScore = 0;
    const reasons: string[] = [];
    const evidence: Record<string, unknown> = {};

    // 1) Identifier continuity
    const idSimilarity = jaccardSimilarity(left.identifierTokens, right.identifierTokens);
    evidence.identifierSimilarity = idSimilarity;
    if (idSimilarity >= 0.34) {
      continuationScore += 0.4;
      reasons.push("identifier_continuity");
    } else if (left.identifierTokens.length > 0 && right.identifierTokens.length > 0) {
      boundaryScore += 0.4;
      reasons.push("identifier_shift");
    }

    // 2) Page numbering continuity
    if (left.pageNumberCue?.page && right.pageNumberCue?.page) {
      evidence.pageNumberCue = { left: left.pageNumberCue, right: right.pageNumberCue };
      const sequential = right.pageNumberCue.page === left.pageNumberCue.page + 1;
      if (sequential) {
        continuationScore += 0.25;
        reasons.push("page_number_continuity");
      }
      if (right.pageNumberCue.page === 1 && left.pageNumberCue.page > 1) {
        boundaryScore += 0.25;
        reasons.push("page_number_restart");
      }
    }

    // 3) Template/layout continuity
    const sameTemplate = left.templateSignature === right.templateSignature;
    const layoutSimilarity = jaccardSimilarity(left.layoutHints, right.layoutHints);
    evidence.layoutSimilarity = layoutSimilarity;
    if (sameTemplate || layoutSimilarity >= 0.5) {
      continuationScore += 0.2;
      reasons.push("template_continuity");
    } else {
      boundaryScore += 0.2;
      reasons.push("template_change");
    }

    // 4) Abrupt title/header restart
    const leftHeader = (left.headerTitle || "").toLowerCase();
    const rightHeader = (right.headerTitle || "").toLowerCase();
    const sameHeader = leftHeader.length > 0 && rightHeader.length > 0 && leftHeader === rightHeader;
    evidence.headerTransition = { left: left.headerTitle, right: right.headerTitle };
    if (!sameHeader && headerRestartCandidate(right.headerTitle)) {
      boundaryScore += 0.35;
      reasons.push("header_restart");
    }

    continuationScore = bounded(continuationScore);
    boundaryScore = bounded(boundaryScore);
    const delta = boundaryScore - continuationScore;
    const confidence = Number(bounded(Math.abs(delta) * 1.5).toFixed(3));

    const decision: BoundaryDecision =
      delta >= 0.25 ? "split"
      : delta <= -0.25 ? "continue"
      : "uncertain";

    decisions.push({
      leftPageIndex: left.pageIndex,
      rightPageIndex: right.pageIndex,
      continuationScore: Number(continuationScore.toFixed(3)),
      boundaryScore: Number(boundaryScore.toFixed(3)),
      confidence,
      decision,
      reasons,
      evidence,
    });
  }

  return decisions;
}

export function proposePdfSegments(
  pageCount: number,
  boundaries: PdfBoundaryDecision[],
): { segments: ProposedPageSegment[]; uncertainEdges: number } {
  if (pageCount <= 0) {
    return { segments: [], uncertainEdges: 0 };
  }

  const segments: ProposedPageSegment[] = [];
  let startPage = 1;
  let uncertainEdges = 0;

  for (const edge of boundaries) {
    if (edge.decision === "uncertain") uncertainEdges += 1;

    if (edge.decision === "split") {
      segments.push({
        startPage,
        endPage: edge.leftPageIndex,
        confidence: edge.confidence,
        reason: edge.reasons.join(",") || "boundary_signal",
      });
      startPage = edge.rightPageIndex;
    }
  }

  segments.push({
    startPage,
    endPage: pageCount,
    confidence: 0.75,
    reason: "final_segment",
  });

  return { segments, uncertainEdges };
}
