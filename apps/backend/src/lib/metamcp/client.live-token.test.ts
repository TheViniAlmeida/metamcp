import { ServerParameters } from "@repo/zod-types";
import { describe, expect, it, vi } from "vitest";

// The streamable HTTP transport of an OAuth server must send its requests
// through the live-token fetch; otherwise the pooled connection keeps the
// access token it was built with until it expires.

const mocks = vi.hoisted(() => ({
  createLiveTokenFetch: vi.fn(() => vi.fn()),
}));

vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../db/repositories", () => ({ oauthSessionsRepository: {} }));
vi.mock("../oauth-upstream/live-token-fetch", () => ({
  createLiveTokenFetch: mocks.createLiveTokenFetch,
}));
vi.mock("../../db/repositories/oauth-sessions.repo", () => ({
  oauthSessionsRepository: {},
}));
vi.mock("./server-error-tracker", () => ({ serverErrorTracker: {} }));

import { createMetaMcpClient } from "./client";

const server = (overrides: Partial<ServerParameters>): ServerParameters => ({
  uuid: "00000000-0000-0000-0000-0000000000aa",
  name: "titan",
  description: "",
  type: "STREAMABLE_HTTP",
  created_at: new Date().toISOString(),
  status: "active",
  stderr: "inherit" as const,
  url: "https://mcp.example.com/mcp",
  headers: {},
  ...overrides,
});

const transportFetch = (params: ServerParameters) =>
  (createMetaMcpClient(params).transport as unknown as { _fetch?: unknown })
    ._fetch;

describe("createMetaMcpClient live token", () => {
  it("routes an OAuth server through the live-token fetch", () => {
    const params = server({
      oauth_tokens: {
        access_token: "AT",
        token_type: "Bearer",
        refresh_token: "RT",
      },
    });

    expect(transportFetch(params)).toBe(
      mocks.createLiveTokenFetch.mock.results.at(-1)?.value,
    );
    expect(mocks.createLiveTokenFetch).toHaveBeenLastCalledWith(params, "AT");
  });

  it("leaves a static bearer server alone", () => {
    mocks.createLiveTokenFetch.mockClear();

    expect(
      transportFetch(server({ bearerToken: "sk_static" })),
    ).toBeUndefined();
    expect(mocks.createLiveTokenFetch).not.toHaveBeenCalled();
  });
});
