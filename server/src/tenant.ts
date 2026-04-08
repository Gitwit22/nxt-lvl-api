import type { Request } from "express";
import { CURRENT_PROGRAM_DOMAIN, DEFAULT_ORGANIZATION_ID } from "./core/config/env.js";
import { getRequestUser } from "./core/auth/auth.service.js";

export interface TenantScope {
  organizationId: string;
  programDomain: string;
}

export function getDefaultTenantScope(): TenantScope {
  return {
    organizationId: DEFAULT_ORGANIZATION_ID,
    programDomain: CURRENT_PROGRAM_DOMAIN,
  };
}

export function getTenantScopeForUser(
  user?: { organizationId?: string; programDomain?: string } | null,
): TenantScope {
  return {
    organizationId: user?.organizationId || DEFAULT_ORGANIZATION_ID,
    programDomain: user?.programDomain || CURRENT_PROGRAM_DOMAIN,
  };
}

export function getRequestTenantScope(req: Request): TenantScope {
  return getTenantScopeForUser(getRequestUser(req));
}