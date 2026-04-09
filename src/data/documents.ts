export interface Document {
  id: string;
  title: string;
  year: number;
  author: string;
  category: string;
  type: string;
  description: string;
  keywords: string[];
  fileUrl: string;
  createdAt: string;
  aiSummary: string;
}

export const mockDocuments: Document[] = [
  {
    id: "1",
    title: "Founding Charter & Mission Statement",
    year: 1987,
    author: "Community Chronicle Coalition",
    category: "Policy",
    type: "Report",
    description:
      "Original charter that established the coalition's mission to advance racial equity, housing stability, and civic participation.",
    keywords: ["charter", "mission", "civil rights", "equity", "governance"],
    fileUrl: "#",
    createdAt: "1987-03-15T00:00:00.000Z",
    aiSummary:
      "Foundational governance document defining long-term equity goals and organizational commitments.",
  },
  {
    id: "2",
    title: "Predatory Lending Impact Study",
    year: 1992,
    author: "Dr. Lena Morris",
    category: "Research",
    type: "Study",
    description:
      "Neighborhood-level analysis of predatory lending patterns and foreclosure risk across historically disinvested blocks.",
    keywords: ["predatory lending", "foreclosure", "credit access", "housing", "equity"],
    fileUrl: "#",
    createdAt: "1992-09-22T00:00:00.000Z",
    aiSummary:
      "Quantitative evidence linking predatory lending exposure to long-term household instability.",
  },
  {
    id: "3",
    title: "Housing Justice Listening Sessions",
    year: 1998,
    author: "Community Archive Team",
    category: "Housing",
    type: "Report",
    description:
      "Compiled testimonies from residents about displacement pressure, rent burden, and neighborhood change.",
    keywords: ["housing", "displacement", "tenant rights", "community voice"],
    fileUrl: "#",
    createdAt: "1998-05-10T00:00:00.000Z",
    aiSummary:
      "Resident testimony report documenting early warning signs of displacement.",
  },
  {
    id: "4",
    title: "Youth Civic Leadership Program Brief",
    year: 2003,
    author: "Ari Thompson",
    category: "Youth Initiative",
    type: "Brief",
    description:
      "Program design brief for youth-led policy training, mentorship pipelines, and public hearing participation.",
    keywords: ["youth", "leadership", "civic engagement", "training"],
    fileUrl: "#",
    createdAt: "2003-01-28T00:00:00.000Z",
    aiSummary:
      "Operational blueprint for scaling youth participation in local policy processes.",
  },
  {
    id: "5",
    title: "Equity in Public School Funding",
    year: 2008,
    author: "Marisol Grant",
    category: "Education",
    type: "Study",
    description:
      "Comparative funding analysis highlighting disparities in facilities, instructional support, and enrichment access.",
    keywords: ["education", "school funding", "equity", "resource allocation"],
    fileUrl: "#",
    createdAt: "2008-11-04T00:00:00.000Z",
    aiSummary:
      "Data-backed case for weighted funding formulas and transparent district reporting.",
  },
  {
    id: "6",
    title: "Civil Rights Litigation Strategy Memo",
    year: 2011,
    author: "N. Patel, Esq.",
    category: "Legal",
    type: "Brief",
    description:
      "Internal memo on legal strategy, evidence collection, and compliance pathways for anti-discrimination cases.",
    keywords: ["legal", "litigation", "compliance", "civil rights", "statute"],
    fileUrl: "#",
    createdAt: "2011-06-13T00:00:00.000Z",
    aiSummary:
      "Action-oriented legal brief aligning litigation priorities with community impact goals.",
  },
  {
    id: "7",
    title: "Community Health & Environment Report",
    year: 2015,
    author: "Public Health Working Group",
    category: "Community Report",
    type: "Report",
    description:
      "Cross-sector report on air quality, transit exposure, and health disparities near major industrial corridors.",
    keywords: ["health", "environment", "community report", "air quality", "equity"],
    fileUrl: "#",
    createdAt: "2015-02-19T00:00:00.000Z",
    aiSummary:
      "Links environmental burden indicators to measurable neighborhood health outcomes.",
  },
  {
    id: "8",
    title: "Transit Access Policy Recommendations",
    year: 2018,
    author: "Mobility Justice Lab",
    category: "Policy",
    type: "Presentation",
    description:
      "Policy deck proposing service equity metrics for bus frequency, route reliability, and fare burden reduction.",
    keywords: ["policy", "transit", "mobility", "equity", "public investment"],
    fileUrl: "#",
    createdAt: "2018-08-30T00:00:00.000Z",
    aiSummary:
      "Recommendation set for implementing measurable transportation equity standards.",
  },
  {
    id: "9",
    title: "Mutual Aid Network Newsletter",
    year: 2021,
    author: "Community Chronicle Editorial",
    category: "Community Report",
    type: "Newsletter",
    description:
      "Quarterly highlights of neighborhood food distribution, legal clinics, and volunteer mobilization outcomes.",
    keywords: ["newsletter", "mutual aid", "community", "organizing"],
    fileUrl: "#",
    createdAt: "2021-04-12T00:00:00.000Z",
    aiSummary:
      "Narrative and metrics snapshot of grassroots response programs and local participation.",
  },
  {
    id: "10",
    title: "Digital Equity Access Survey Results",
    year: 2023,
    author: "Data Systems Team",
    category: "Research",
    type: "Study",
    description:
      "Survey findings on broadband reliability, device access, and digital service barriers for residents.",
    keywords: ["digital equity", "broadband", "research", "access", "inclusion"],
    fileUrl: "#",
    createdAt: "2023-10-03T00:00:00.000Z",
    aiSummary:
      "Recent baseline on digital access gaps with recommendations for targeted investment.",
  },
];