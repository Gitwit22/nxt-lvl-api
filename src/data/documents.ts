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
    aiSummary: "This 1985 founding document establishes the Michigan Roundtable's core mission: advancing racial justice, promoting housing equity, and empowering communities across metropolitan Detroit. It outlines the organizational structure, key objectives, and the guiding principles that would shape decades of advocacy work.",
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
    aiSummary: "This 1992 study by Dr. Eleanor Williams provides a data-driven analysis of residential segregation in metro Detroit. It maps demographic shifts, documents redlining's lasting effects, and quantifies disparities in neighborhood investment between predominantly white and Black communities. The research became a foundational reference for fair housing advocacy in Michigan.",
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
    aiSummary: "The inaugural 1994 policy report examines the state of fair housing enforcement in Michigan. It identifies gaps in discrimination complaint processing, documents lending bias against minority homebuyers, and proposes 12 policy recommendations for equitable housing development. Several recommendations were later adopted by local municipalities.",
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
    aiSummary: "Dr. Thompson's 1998 assessment reveals that Michigan school districts serving predominantly Black and Latino students receive up to 40% less per-pupil funding than affluent suburban counterparts. The study traces this disparity to property tax dependency and proposes alternative funding models that would ensure equitable resource distribution across all districts.",
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
    aiSummary: "This grassroots report compiles survey responses and oral histories from over 500 residents across 12 Detroit neighborhoods. Key themes include the impact of commercial disinvestment, concerns about policing practices, and the power of community organizing. The report directly influenced the creation of three new neighborhood advisory councils.",
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
    aiSummary: "This landmark 2003 report provides a comprehensive cross-sector analysis of equity in the greater Detroit region. It examines housing access, employment rates, and health outcomes across racial lines, revealing persistent disparities despite civil rights progress. The report proposes an integrated policy framework addressing all three domains simultaneously.",
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
    aiSummary: "This 2005 legal brief documents systematic predatory lending targeting African American and Latino homeowners in Detroit. It presents 8 detailed case studies showing how subprime lenders used deceptive practices to extract wealth from communities of color. The brief's recommendations for stronger consumer protections proved prescient ahead of the 2008 financial crisis.",
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
    aiSummary: "This program report covers the first five years of the Youth Leadership Initiative (2005–2010). It documents that 89% of participants increased civic engagement, 78% enrolled in higher education, and collectively contributed over 15,000 community service hours. The initiative's peer mentoring model is highlighted as a replicable best practice.",
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
    aiSummary: "This legislative testimony addresses the water crisis affecting Detroit and Flint residents. It documents how water shutoffs disproportionately impact low-income communities of color, presents data on contamination risks, and argues that access to clean, affordable water is a fundamental civil rights issue. The testimony calls for a statewide water affordability plan.",
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
    aiSummary: "Dr. Reynolds' 2021 study quantifies COVID-19's disproportionate toll on communities of color in Michigan: 2.3x higher hospitalization rates, 35% greater job losses, and significant learning gaps for students of color. The study proposes a 5-pillar equitable recovery framework addressing health infrastructure, economic relief, educational support, housing stability, and digital access.",
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
