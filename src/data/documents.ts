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
}

export interface TimelineEvent {
  year: number;
  title: string;
  description: string;
  documentIds?: string[];
}

export const categories = [
  "Research",
  "Policy",
  "Community Report",
  "Youth Initiative",
  "Housing",
  "Education",
  "Legal",
] as const;

export const documentTypes = [
  "Report",
  "Brief",
  "Study",
  "Newsletter",
  "Testimony",
  "Presentation",
] as const;

export const mockDocuments: Document[] = [
  {
    id: "1",
    title: "Founding Charter & Mission Statement",
    year: 1985,
    author: "Michigan Roundtable",
    category: "Policy",
    type: "Report",
    description: "The original founding charter establishing the organization's commitment to racial justice, housing equity, and community empowerment in metropolitan Detroit.",
    keywords: ["founding", "mission", "charter", "Detroit", "racial justice"],
    fileUrl: "#",
    createdAt: "1985-03-15",
  },
  {
    id: "2",
    title: "Housing Segregation Patterns in Metro Detroit",
    year: 1992,
    author: "Dr. Eleanor Williams",
    category: "Research",
    type: "Study",
    description: "Comprehensive analysis of residential segregation patterns across the Detroit metropolitan area, documenting disparities in housing access and neighborhood investment.",
    keywords: ["housing", "segregation", "Detroit", "residential patterns", "disparities"],
    fileUrl: "#",
    createdAt: "1992-06-01",
  },
  {
    id: "3",
    title: "First Annual Policy Report on Fair Housing",
    year: 1994,
    author: "Michigan Roundtable",
    category: "Policy",
    type: "Report",
    description: "Inaugural policy report examining fair housing enforcement, lending discrimination, and policy recommendations for equitable housing development.",
    keywords: ["fair housing", "policy", "lending", "discrimination", "enforcement"],
    fileUrl: "#",
    createdAt: "1994-01-10",
  },
  {
    id: "4",
    title: "School Equity Assessment: K-12 Funding Disparities",
    year: 1998,
    author: "Dr. Marcus Thompson",
    category: "Education",
    type: "Study",
    description: "Data-driven assessment of K-12 funding disparities across school districts in Michigan, revealing systemic inequities tied to property tax bases and racial composition.",
    keywords: ["education", "equity", "K-12", "funding", "school districts"],
    fileUrl: "#",
    createdAt: "1998-09-15",
  },
  {
    id: "5",
    title: "Community Voices: Neighborhood Impact Survey",
    year: 2000,
    author: "Community Research Team",
    category: "Community Report",
    type: "Report",
    description: "Survey-based report collecting narratives from residents across 12 Detroit neighborhoods about the impact of disinvestment, policing, and community organizing.",
    keywords: ["community", "survey", "neighborhoods", "Detroit", "voices"],
    fileUrl: "#",
    createdAt: "2000-04-20",
  },
  {
    id: "6",
    title: "2003 Community Equity Report",
    year: 2003,
    author: "Michigan Roundtable",
    category: "Research",
    type: "Report",
    description: "Landmark equity report analyzing housing, employment, and health outcomes across racial lines in the greater Detroit region.",
    keywords: ["housing", "equity", "Detroit", "employment", "health"],
    fileUrl: "#",
    createdAt: "2003-11-01",
  },
  {
    id: "7",
    title: "Legal Brief: Predatory Lending in Communities of Color",
    year: 2005,
    author: "Legal Action Committee",
    category: "Legal",
    type: "Brief",
    description: "Legal analysis of predatory lending practices targeting African American and Latino homeowners, with case studies and policy recommendations.",
    keywords: ["predatory lending", "legal", "communities of color", "homeownership"],
    fileUrl: "#",
    createdAt: "2005-07-12",
  },
  {
    id: "8",
    title: "Youth Leadership Initiative: Program Report",
    year: 2010,
    author: "Youth Programs Division",
    category: "Youth Initiative",
    type: "Report",
    description: "Report on the first five years of the Youth Leadership Initiative, documenting outcomes in civic engagement, college readiness, and community service.",
    keywords: ["youth", "leadership", "civic engagement", "program outcomes"],
    fileUrl: "#",
    createdAt: "2010-05-30",
  },
  {
    id: "9",
    title: "Testimony: Water Affordability & Environmental Justice",
    year: 2015,
    author: "Michigan Roundtable",
    category: "Policy",
    type: "Testimony",
    description: "Testimony before the Michigan legislature on the intersection of water affordability, shutoffs, and environmental justice in Detroit and Flint.",
    keywords: ["water", "environmental justice", "testimony", "Flint", "Detroit"],
    fileUrl: "#",
    createdAt: "2015-02-18",
  },
  {
    id: "10",
    title: "Racial Equity in the Post-Pandemic Recovery",
    year: 2021,
    author: "Dr. Aisha Reynolds",
    category: "Research",
    type: "Study",
    description: "Research study on the disproportionate economic, health, and educational impacts of COVID-19 on communities of color, with a framework for equitable recovery.",
    keywords: ["COVID-19", "racial equity", "pandemic", "recovery", "health disparities"],
    fileUrl: "#",
    createdAt: "2021-08-05",
  },
];

export const timelineEvents: TimelineEvent[] = [
  { year: 1985, title: "Organization Founded", description: "Michigan Roundtable established to advance racial justice and community equity.", documentIds: ["1"] },
  { year: 1992, title: "First Housing Study", description: "Landmark research on housing segregation patterns in metropolitan Detroit.", documentIds: ["2"] },
  { year: 1994, title: "First Policy Report", description: "Inaugural annual policy report on fair housing enforcement and reform.", documentIds: ["3"] },
  { year: 1998, title: "Education Equity Assessment", description: "Comprehensive study revealing K-12 funding disparities tied to race and geography.", documentIds: ["4"] },
  { year: 2003, title: "Community Equity Report", description: "Major report analyzing equity across housing, employment, and health.", documentIds: ["6"] },
  { year: 2005, title: "Predatory Lending Legal Action", description: "Legal brief challenging discriminatory lending practices.", documentIds: ["7"] },
  { year: 2010, title: "Youth Initiative Launched", description: "Youth Leadership Initiative program report showcasing five years of impact.", documentIds: ["8"] },
  { year: 2015, title: "Environmental Justice Testimony", description: "Legislative testimony on water affordability and environmental racism.", documentIds: ["9"] },
  { year: 2021, title: "Post-Pandemic Equity Study", description: "Research on COVID-19's disproportionate impact on communities of color.", documentIds: ["10"] },
];
