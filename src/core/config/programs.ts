export type ProgramDefinition = {
  displayName: string;
  routePrefix: string;
  allowedOrigins: string[];
};

export const programs: Record<string, ProgramDefinition> = {
  eventure: {
    displayName: "Eventure",
    routePrefix: "/api/eventure",
    allowedOrigins: ["https://eventure.nltops.com"],
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
