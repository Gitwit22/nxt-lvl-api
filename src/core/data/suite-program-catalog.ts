export interface SuiteProgramSeed {
  id: string;
  slug: string;
  organizationId: string | null;
  name: string;
  shortDescription: string;
  longDescription: string;
  category: string;
  tags: string[];
  status: string;
  type: string;
  origin: string;
  internalRoute: string | null;
  externalUrl: string | null;
  openInNewTab: boolean;
  logoUrl: string | null;
  screenshotUrl: string | null;
  accentColor: string | null;
  isFeatured: boolean;
  isPublic: boolean;
  requiresLogin: boolean;
  requiresApproval: boolean;
  launchLabel: string;
  displayOrder: number;
  notes: string;
}

export const SUITE_PROGRAM_DOMAIN = "nxt-lvl-suites";

export const suiteProgramCatalog: SuiteProgramSeed[] = [
  {
    id: "program-community-chronicle",
    slug: "community-chronicle",
    organizationId: null,
    name: "Community Chronicle",
    shortDescription: "Story-driven public publishing and engagement tools for community organizations.",
    longDescription:
      "Community Chronicle gives teams a focused publishing environment for updates, local reporting, public storytelling, and audience engagement. It is designed for organizations that need a clean outward-facing experience while keeping editorial operations organized behind the scenes.",
    category: "Media",
    tags: ["publishing", "community", "storytelling"],
    status: "live",
    type: "external",
    origin: "suite-native",
    internalRoute: null,
    externalUrl: "https://community-chronicle.nltops.com",
    openInNewTab: true,
    logoUrl: null,
    screenshotUrl: null,
    accentColor: "#14b8a6",
    isFeatured: true,
    isPublic: true,
    requiresLogin: false,
    requiresApproval: false,
    launchLabel: "Launch Site",
    displayOrder: 1,
    notes: "External launch experience.",
  },
  {
    id: "program-timeflow",
    slug: "timeflow",
    organizationId: null,
    name: "TimeFlow",
    shortDescription: "Operational time, scheduling, and workforce coordination in one internal workspace.",
    longDescription:
      "TimeFlow centralizes scheduling, team allocation, time tracking, and workforce visibility for organizations that need a single operational pulse. Internal teams can move from planning to execution without leaving the Suite.",
    category: "Operations",
    tags: ["scheduling", "workforce", "operations"],
    status: "live",
    type: "external",
    origin: "suite-native",
    internalRoute: null,
    externalUrl: "https://timeflow.nltops.com",
    openInNewTab: true,
    logoUrl: null,
    screenshotUrl: null,
    accentColor: "#3b82f6",
    isFeatured: true,
    isPublic: true,
    requiresLogin: true,
    requiresApproval: false,
    launchLabel: "Launch App",
    displayOrder: 2,
    notes: "External launch to TimeFlow production site.",
  },
  {
    id: "program-nonprofit-hub",
    slug: "support-hub",
    organizationId: null,
    name: "Support Hub",
    shortDescription: "Structured service intake, case routing, and support coordination for staff teams.",
    longDescription:
      "Support Hub is built for intake-heavy teams that need to capture requests, coordinate response workflows, and keep service delivery visible across departments. It is intended for internal use and respects Suite authentication before launch.",
    category: "Nonprofit",
    tags: ["support", "intake", "services"],
    status: "beta",
    type: "internal",
    origin: "suite-native",
    internalRoute: "/workspace/support-hub",
    externalUrl: null,
    openInNewTab: false,
    logoUrl: null,
    screenshotUrl: null,
    accentColor: "#8b5cf6",
    isFeatured: true,
    isPublic: true,
    requiresLogin: true,
    requiresApproval: false,
    launchLabel: "Launch App",
    displayOrder: 3,
    notes: "Internal beta workspace.",
  },
  {
    id: "program-field-ops",
    slug: "horizon",
    organizationId: null,
    name: "Horizon",
    shortDescription: "Foresight dashboards and planning tools for roadmap, field visibility, and strategic execution.",
    longDescription:
      "Horizon is the planning layer for teams that need to coordinate initiatives, track upcoming deployments, and align execution with broader organizational goals. The public catalog can preview Horizon now while the workspace continues toward launch readiness.",
    category: "Analytics",
    tags: ["planning", "roadmap", "visibility"],
    status: "coming-soon",
    type: "internal",
    origin: "suite-native",
    internalRoute: "/workspace/horizon",
    externalUrl: null,
    openInNewTab: false,
    logoUrl: null,
    screenshotUrl: null,
    accentColor: "#f59e0b",
    isFeatured: false,
    isPublic: true,
    requiresLogin: true,
    requiresApproval: false,
    launchLabel: "Coming Soon",
    displayOrder: 4,
    notes: "Coming soon preview.",
  },
  {
    id: "program-insight-studio",
    slug: "mejay",
    organizationId: null,
    name: "MeJay",
    shortDescription: "A branded digital presence and service layer for outreach, identity, and creator-led engagement.",
    longDescription:
      "MeJay combines identity-driven presentation with tools for direct engagement, audience touchpoints, and branded communication flows. It launches as an external experience so visitors can move directly into the site or product environment.",
    category: "Communication",
    tags: ["brand", "engagement", "creator"],
    status: "live",
    type: "external",
    origin: "external-partner",
    internalRoute: null,
    externalUrl: "https://mejay.ntlops.com",
    openInNewTab: true,
    logoUrl: null,
    screenshotUrl: null,
    accentColor: "#ec4899",
    isFeatured: false,
    isPublic: true,
    requiresLogin: false,
    requiresApproval: false,
    launchLabel: "Launch Site",
    displayOrder: 5,
    notes: "External launch experience.",
  },
  {
    id: "program-streamline",
    slug: "streamline",
    organizationId: null,
    name: "StreamLine",
    shortDescription: "Workflow automation and request routing across programs, services, and partner operations.",
    longDescription:
      "StreamLine reduces handoff friction between teams by automating intake, routing work to the right owners, and standardizing service flows across the organization. It is an internal application that uses Suite authentication before users can enter the workspace.",
    category: "Operations",
    tags: ["workflow", "automation", "routing"],
    status: "live",
    type: "internal",
    origin: "suite-native",
    internalRoute: "/workspace/streamline",
    externalUrl: null,
    openInNewTab: false,
    logoUrl: null,
    screenshotUrl: null,
    accentColor: "#22c55e",
    isFeatured: false,
    isPublic: true,
    requiresLogin: true,
    requiresApproval: false,
    launchLabel: "Launch App",
    displayOrder: 6,
    notes: "Internal suite workspace.",
  },
];
