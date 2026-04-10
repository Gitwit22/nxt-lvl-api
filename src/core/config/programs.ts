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
    allowedOrigins: ["https://nltops.com", "https://ntlops.com"],
    // Suite host is the central identity provider entry point, so it must allow
    // direct local login/register while child apps can remain platform_only.
    authMode: "hybrid",
  },
};

/**
 * Auth mode reference:
 *
 * - "platform_only": Centralized Suite login. Internal apps redirect unauthenticated users
 *   to Suite login; after successful auth, user is returned to the app already authenticated.
 *   Used for all Suite-managed internal applications and org portals.
 *   One username/password for all internal apps.
 *
 * - "local_only": Direct email/password login to the app. No Suite redirect.
 *   Users register and authenticate independently within that app.
 *   Used for public-facing or standalone services with independent credential management.
 *
 * - "hybrid": Both platform and local auth allowed. App-level rules determine flow.
 *   Useful for advanced products like StreamLine that may need flexible auth strategies.
 *
 * Standards:
 * - Internal Suite apps use platform_only for unified login experience.
 * - External/public apps use local_only or no auth.
 * - Advanced products like StreamLine can use hybrid where specialized flows are needed.
 */

export function getProgramDefinition(key: string): ProgramDefinition | undefined {
  return programs[key];
}
