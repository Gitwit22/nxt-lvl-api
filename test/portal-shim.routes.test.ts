import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";

describe("legacy /api/portal compatibility shims", () => {
  it("redirects GET /api/portal/bootstrap to canonical /api/orgs/bootstrap", async () => {
    const response = await request(app).get("/api/portal/bootstrap?slug=acme");

    expect(response.status).toBe(301);
    expect(response.headers.location).toBe("/api/orgs/bootstrap?slug=acme");
  });

  it("redirects POST /api/portal/:orgId/provision to canonical /api/orgs/:orgId/provision", async () => {
    const response = await request(app).post("/api/portal/org-123/provision");

    expect(response.status).toBe(308);
    expect(response.headers.location).toBe("/api/orgs/org-123/provision");
  });
});

// TODO(compat-removal): delete this test when /api/portal/* shims are removed.
// Replacement target: keep coverage on canonical routes in org bootstrap/provision tests.
