import { describe, expect, it } from "vitest";

import type { ApiKeyAuthenticatedRequest } from "@/middleware/api-key-oauth.middleware";

import { SessionOwnerRegistry } from "./session-owner";

// A session ID must only work through the endpoint and credential that opened
// it; otherwise a key for one namespace can drive another namespace's session.

function req(
  endpointUuid: string,
  auth: { apiKeyUuid?: string; oauthUserId?: string },
): ApiKeyAuthenticatedRequest {
  return {
    endpoint: { uuid: endpointUuid },
    ...auth,
  } as unknown as ApiKeyAuthenticatedRequest;
}

describe("SessionOwnerRegistry", () => {
  it("accepts the endpoint and key that opened the session", () => {
    const owners = new SessionOwnerRegistry();
    owners.record("s1", req("ep-infra", { apiKeyUuid: "key-infra" }));
    expect(
      owners.isOwner("s1", req("ep-infra", { apiKeyUuid: "key-infra" })),
    ).toBe(true);
  });

  it("rejects the session from another endpoint, even with a valid key", () => {
    const owners = new SessionOwnerRegistry();
    owners.record("s1", req("ep-infra", { apiKeyUuid: "key-infra" }));
    expect(owners.isOwner("s1", req("ep-eq", { apiKeyUuid: "key-eq" }))).toBe(
      false,
    );
    expect(
      owners.isOwner("s1", req("ep-eq", { apiKeyUuid: "key-infra" })),
    ).toBe(false);
  });

  it("rejects another key on the same endpoint", () => {
    const owners = new SessionOwnerRegistry();
    owners.record("s1", req("ep-infra", { apiKeyUuid: "key-a" }));
    expect(owners.isOwner("s1", req("ep-infra", { apiKeyUuid: "key-b" }))).toBe(
      false,
    );
    expect(
      owners.isOwner("s1", req("ep-infra", { oauthUserId: "user-1" })),
    ).toBe(false);
  });

  it("fails closed for unknown and forgotten sessions", () => {
    const owners = new SessionOwnerRegistry();
    const r = req("ep-infra", { apiKeyUuid: "key-infra" });
    expect(owners.isOwner("missing", r)).toBe(false);
    owners.record("s1", r);
    owners.forget("s1");
    expect(owners.isOwner("s1", r)).toBe(false);
  });
});
