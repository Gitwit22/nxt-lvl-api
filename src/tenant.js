import { CURRENT_PROGRAM_DOMAIN, DEFAULT_ORGANIZATION_ID } from "./config.js";
import { getRequestUser } from "./auth.js";
export function getDefaultTenantScope() {
    return {
        organizationId: DEFAULT_ORGANIZATION_ID,
        programDomain: CURRENT_PROGRAM_DOMAIN,
    };
}
export function getTenantScopeForUser(user) {
    return {
        organizationId: user?.organizationId || DEFAULT_ORGANIZATION_ID,
        programDomain: user?.programDomain || CURRENT_PROGRAM_DOMAIN,
    };
}
export function getRequestTenantScope(req) {
    return getTenantScopeForUser(getRequestUser(req));
}