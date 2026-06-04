export type ProgramDefinition = {
  displayName: string;
  routePrefix: string;
  allowedOrigins: string[];
};

function parseOriginsCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

const ENV_PROGRAM_ALLOWED_ORIGINS = parseOriginsCsv(process.env.PROGRAM_ALLOWED_ORIGINS);
const ENV_EVENTURE_ALLOWED_ORIGINS = parseOriginsCsv(process.env.EVENTURE_ALLOWED_ORIGINS);

const EVENTURE_ALLOWED_ORIGINS = Array.from(
  new Set([
    ...ENV_PROGRAM_ALLOWED_ORIGINS,
    ...ENV_EVENTURE_ALLOWED_ORIGINS,
  ]),
);

export const programs: Record<string, ProgramDefinition> = {
  eventure: {
    displayName: "Eventure",
    routePrefix: "/api/eventure",
    allowedOrigins:
      EVENTURE_ALLOWED_ORIGINS.length > 0
        ? EVENTURE_ALLOWED_ORIGINS
        : ["https://eventure.nltops.com", "http://localhost:5173"],
  },
  "financial-hub": {
    displayName: "Financial Hub",
    routePrefix: "/api/financial-hub",
    allowedOrigins: [],
  },
  "mission-hub": {
    displayName: "Mission Hub",
    routePrefix: "/api/mission-hub",
    allowedOrigins: [
      "https://nonprofitops.nltops.com",
      "https://mission-hub.pages.dev",
    ],
  },
  "community-chronicle": {
    displayName: "Community Chronicle",
    routePrefix: "/api/community-chronicle",
    allowedOrigins: ["https://community-chronicle.nltops.com"],
  },
  "nxt-lvl-suites": {
    displayName: "Nxt Lvl Suite",
    routePrefix: "/api/nxt-lvl-suite",
    allowedOrigins: [
      "https://nltops.com",
      "https://ntlops.com",
      "https://www.ntlops.com",
      "https://www.nltops.com",
    ],
  },
  "timeflow": {
    displayName: "Timeflow",
    routePrefix: "/api/timeflow",
    allowedOrigins: [],
  },
};

export function getProgramDefinition(key: string): ProgramDefinition | undefined {
  return programs[key];
}
