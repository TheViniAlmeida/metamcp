import type { AddressInfo } from "node:net";

import express from "express";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// An API key scoped to one endpoint must open only that endpoint (one key per
// namespace, so a key from one namespace never opens another) and must never
// receive the account-wide MetaMCP admin tools.

const mocks = vi.hoisted(() => ({
  validateApiKey: vi.fn(),
}));

vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../db/repositories/api-keys.repo", () => ({
  ApiKeysRepository: class {
    validateApiKey = mocks.validateApiKey;
  },
}));

vi.mock("../db/index", () => ({
  db: {
    select: () => ({
      from: () => ({ limit: async () => [{ id: "first-user" }] }),
    }),
  },
}));

import { buildAdminToolsOptions } from "../lib/admin-mcp/build-admin-tools-options";
import { resolveUserIdFromApiKey } from "../lib/admin-mcp/resolve-user";
import {
  type ApiKeyAuthenticatedRequest,
  authenticateApiKey,
  checkApiKeyAccess,
} from "./api-key-oauth.middleware";

const OWNER = "user-1";
const INFRA = "11111111-1111-4111-8111-111111111111";
const EQ = "22222222-2222-4222-8222-222222222222";
const PUBLIC_EP = "33333333-3333-4333-8333-333333333333";

function endpoint(uuid: string, userId: string | null) {
  return {
    uuid,
    name: `ep-${uuid.slice(0, 4)}`,
    user_id: userId,
    enable_api_key_auth: true,
    enable_oauth: false,
    use_query_param_auth: false,
    enable_metamcp_admin_tools: true,
  } as unknown as ApiKeyAuthenticatedRequest["endpoint"];
}

describe("checkApiKeyAccess with endpoint scope", () => {
  it("allows a scoped key on its own endpoint", () => {
    expect(
      checkApiKeyAccess(
        { user_id: OWNER, endpoint_uuid: INFRA },
        {
          uuid: INFRA,
          user_id: OWNER,
        },
      ).allowed,
    ).toBe(true);
  });

  it("denies a scoped key on another endpoint of the same owner", () => {
    const result = checkApiKeyAccess(
      { user_id: OWNER, endpoint_uuid: INFRA },
      { uuid: EQ, user_id: OWNER },
    );
    expect(result.allowed).toBe(false);
    expect(result.message).toMatch(/different endpoint/);
  });

  it("denies a scoped key on a public endpoint it is not scoped to", () => {
    expect(
      checkApiKeyAccess(
        { user_id: OWNER, endpoint_uuid: INFRA },
        {
          uuid: PUBLIC_EP,
          user_id: null,
        },
      ).allowed,
    ).toBe(false);
  });

  it("keeps the original behaviour for unscoped keys", () => {
    expect(
      checkApiKeyAccess(
        { user_id: OWNER, endpoint_uuid: null },
        {
          uuid: EQ,
          user_id: OWNER,
        },
      ).allowed,
    ).toBe(true);
    expect(
      checkApiKeyAccess({ user_id: OWNER }, { uuid: EQ, user_id: "user-2" })
        .allowed,
    ).toBe(false);
    expect(
      checkApiKeyAccess({ user_id: null }, { uuid: EQ, user_id: OWNER })
        .allowed,
    ).toBe(false);
  });
});

describe("authenticateApiKey with endpoint-scoped keys", () => {
  let baseUrl: string;
  let server: ReturnType<express.Express["listen"]>;
  const seen: Array<Partial<ApiKeyAuthenticatedRequest>> = [];

  beforeAll(async () => {
    const app = express();
    app.get(
      "/:ep",
      (req, _res, next) => {
        const target = req.params.ep === "infra" ? INFRA : EQ;
        const ep = endpoint(target, OWNER);
        // ?oauth=1 turns on OAuth too (condition 3: key sent as Bearer)
        if (req.query.oauth) {
          (ep as { enable_oauth: boolean }).enable_oauth = true;
        }
        (req as ApiKeyAuthenticatedRequest).endpoint = ep;
        next();
      },
      authenticateApiKey,
      (req, res) => {
        const authReq = req as ApiKeyAuthenticatedRequest;
        seen.push({
          apiKeyUserId: authReq.apiKeyUserId,
          apiKeyEndpointUuid: authReq.apiKeyEndpointUuid,
        });
        res.status(200).json({ ok: true });
      },
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    seen.length = 0;
    mocks.validateApiKey.mockReset();
  });

  const get = (path: string, key?: string) =>
    fetch(`${baseUrl}${path}`, {
      headers: key ? { "x-api-key": key } : {},
    });

  it("passes the scoped key on its own endpoint and records the scope", async () => {
    mocks.validateApiKey.mockResolvedValue({
      valid: true,
      user_id: OWNER,
      key_uuid: "key-infra",
      endpoint_uuid: INFRA,
    });
    const res = await get("/infra", "sk_mt_infra");
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ apiKeyUserId: OWNER, apiKeyEndpointUuid: INFRA }]);
  });

  it("returns 403 for the scoped key on another endpoint of the same owner", async () => {
    mocks.validateApiKey.mockResolvedValue({
      valid: true,
      user_id: OWNER,
      key_uuid: "key-infra",
      endpoint_uuid: INFRA,
    });
    const res = await get("/eq", "sk_mt_infra");
    expect(res.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it("applies the scope when OAuth is also on and the key is a Bearer", async () => {
    mocks.validateApiKey.mockResolvedValue({
      valid: true,
      user_id: OWNER,
      key_uuid: "key-infra",
      endpoint_uuid: INFRA,
    });
    const bearer = (path: string) =>
      fetch(`${baseUrl}${path}`, {
        headers: { authorization: "Bearer sk_mt_infra" },
      });
    expect((await bearer("/eq?oauth=1")).status).toBe(403);
    expect((await bearer("/infra?oauth=1")).status).toBe(200);
  });

  it("still returns 401 without a key and with an unknown key", async () => {
    mocks.validateApiKey.mockResolvedValue({ valid: false });
    expect((await get("/eq")).status).toBe(401);
    expect((await get("/eq", "sk_mt_wrong")).status).toBe(401);
  });
});

describe("admin tools never reach endpoint-scoped keys", () => {
  beforeEach(() => {
    mocks.validateApiKey.mockReset();
  });

  it("buildAdminToolsOptions returns nothing for a scoped key", async () => {
    const authReq = {
      headers: { "x-api-key": "sk_mt_infra" },
      apiKeyUserId: OWNER,
      apiKeyEndpointUuid: INFRA,
    } as unknown as ApiKeyAuthenticatedRequest;
    await expect(
      buildAdminToolsOptions(endpoint(INFRA, OWNER), authReq),
    ).resolves.toBeUndefined();
  });

  it("buildAdminToolsOptions still enables them for an unscoped key", async () => {
    const authReq = {
      headers: { "x-api-key": "sk_mt_all" },
      apiKeyUserId: OWNER,
    } as unknown as ApiKeyAuthenticatedRequest;
    await expect(
      buildAdminToolsOptions(endpoint(INFRA, OWNER), authReq),
    ).resolves.toEqual({ enabled: true, userId: OWNER });
  });

  it("buildAdminToolsOptions returns nothing for a public key", async () => {
    const authReq = {
      headers: { "x-api-key": "sk_mt_pub" },
      apiKeyUuid: "key-pub",
    } as unknown as ApiKeyAuthenticatedRequest;
    await expect(
      buildAdminToolsOptions(endpoint(PUBLIC_EP, null), authReq),
    ).resolves.toBeUndefined();
  });

  it("resolveUserIdFromApiKey rejects an unscoped public key", async () => {
    mocks.validateApiKey.mockResolvedValue({
      valid: true,
      user_id: null,
      key_uuid: "key-pub",
      endpoint_uuid: null,
    });
    await expect(resolveUserIdFromApiKey("sk_mt_pub")).rejects.toThrow(
      /Public API keys/,
    );
  });

  it("resolveUserIdFromApiKey rejects a scoped public key", async () => {
    mocks.validateApiKey.mockResolvedValue({
      valid: true,
      user_id: null,
      key_uuid: "key-pub",
      endpoint_uuid: PUBLIC_EP,
    });
    await expect(resolveUserIdFromApiKey("sk_mt_pub")).rejects.toThrow(
      /Endpoint-scoped/,
    );
  });
});
