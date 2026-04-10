export type ProgramAuthMode = "platform_only" | "local_only" | "hybrid";

export type ProgramDefinition = {
  displayName: string;
  routePrefix: string;
  allowedOrigins: string[];
  authMode: ProgramAuthMode;
};

export const programs: Record<string, ProgramDefinition> = {
  "mission-hub": {
    displayName: "Mission Hub",
    routePrefix: "/api/mission-hub",
    allowedOrigins: ["https://mission-hub.onrender.com"],
    authMode: "platform_only",
  },
  "community-chronicle": {
    displayName: "Community Chronicle",
    routePrefix: "/api/community-chronicle",
    allowedOrigins: ["https://community-chronicle.onrender.com"],
    authMode: "platform_only",
  },
  "nxt-lvl-suites": {
    displayName: "Nxt Lvl Suite",
    routePrefix: "/api/nxt-lvl-suite",
    allowedOrigins: ["https://nltops.com"],
    authMode: "platform_only",
  },
};

export function getProgramDefinition(key: string): ProgramDefinition | undefined {
  return programs[key];
}
