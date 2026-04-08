export type ProgramDefinition = {
  displayName: string;
  routePrefix: string;
  allowedOrigins: string[];
};

export const programs: Record<string, ProgramDefinition> = {
  "community-chronicle": {
    displayName: "Community Chronicle",
    routePrefix: "/api/community-chronicle",
    allowedOrigins: ["https://community-chronicle.onrender.com"],
  },
  "nxt-lvl-suites": {
    displayName: "Nxt Lvl Suite",
    routePrefix: "/api/nxt-lvl-suite",
    allowedOrigins: ["https://nltops.com"],
  },
};

export function getProgramDefinition(key: string): ProgramDefinition | undefined {
  return programs[key];
}
