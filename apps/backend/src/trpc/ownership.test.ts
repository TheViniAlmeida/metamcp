import { beforeEach, describe, expect, it, vi } from "vitest";

// A logged-in user may create or update resources for themselves or make them
// public, but never hand them to another user: a key, server, namespace or
// endpoint planted under someone else's account runs as that account.

const mocks = vi.hoisted(() => ({
  createKey: vi.fn(),
  createEndpoint: vi.fn(),
  findEndpointByName: vi.fn(),
  findEndpointByUuid: vi.fn(),
  createNamespace: vi.fn(),
  findNamespace: vi.fn(),
  updateNamespace: vi.fn(),
  createServer: vi.fn(),
  findServer: vi.fn(),
  updateServer: vi.fn(),
}));

vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../db/repositories", () => ({
  ApiKeysRepository: class {
    create = mocks.createKey;
  },
  endpointsRepository: {
    create: mocks.createEndpoint,
    findByName: mocks.findEndpointByName,
    findByUuid: mocks.findEndpointByUuid,
  },
  namespacesRepository: {
    create: mocks.createNamespace,
    findByUuid: mocks.findNamespace,
    update: mocks.updateNamespace,
  },
  mcpServersRepository: {
    create: mocks.createServer,
    findByUuid: mocks.findServer,
    update: mocks.updateServer,
  },
  namespaceMappingsRepository: {},
  oauthSessionsRepository: {},
  toolsRepository: {},
}));

vi.mock("../db/serializers", () => ({
  ApiKeysSerializer: { serializeCreateApiKeyResponse: (x: unknown) => x },
  EndpointsSerializer: { serializeEndpoint: (x: unknown) => x },
  NamespacesSerializer: { serializeNamespace: (x: unknown) => x },
  McpServersSerializer: { serializeMcpServer: (x: unknown) => x },
}));

vi.mock("../lib/metamcp/metamcp-server-pool", () => ({
  metaMcpServerPool: {
    ensureIdleServerForNewNamespace: vi.fn(async () => undefined),
  },
}));
vi.mock("../lib/metamcp/mcp-server-pool", () => ({ mcpServerPool: {} }));
vi.mock("../lib/metamcp/metamcp-middleware/tool-overrides.functional", () => ({
  clearOverrideCache: vi.fn(),
  mapOverrideNameToOriginal: vi.fn(),
}));
vi.mock("../lib/metamcp/server-error-tracker", () => ({
  serverErrorTracker: {},
}));
vi.mock("../lib/metamcp/utils", () => ({ convertDbServerToParams: vi.fn() }));
vi.mock("./pre-registered-oauth", () => ({
  persistPreRegisteredOAuthClient: vi.fn(),
}));

import { canAssignOwner, canChangeOwner } from "../lib/ownership";
import { apiKeysImplementations } from "./api-keys.impl";
import { endpointsImplementations } from "./endpoints.impl";
import { mcpServersImplementations } from "./mcp-servers.impl";
import { namespacesImplementations } from "./namespaces.impl";

// The request schema fills the remaining flags with defaults.
type EndpointInput = Parameters<typeof endpointsImplementations.create>[0];
const endpointInput = (fields: Partial<EndpointInput>) =>
  fields as EndpointInput;

const ME = "user-1";
const OTHER = "user-2";
const NS = "11111111-1111-4111-8111-111111111111";
const EP = "22222222-2222-4222-8222-222222222222";
const SRV = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
});

describe("canAssignOwner", () => {
  it("allows leaving the owner out, claiming it or making it public", () => {
    expect(canAssignOwner(undefined, ME)).toBe(true);
    expect(canAssignOwner(ME, ME)).toBe(true);
    expect(canAssignOwner(null, ME)).toBe(true);
  });

  it("refuses another user", () => {
    expect(canAssignOwner(OTHER, ME)).toBe(false);
  });
});

describe("canChangeOwner", () => {
  it("keeps the owner, or lets an owner make their resource public", () => {
    expect(canChangeOwner(undefined, ME, OTHER)).toBe(true);
    expect(canChangeOwner(ME, ME, ME)).toBe(true);
    expect(canChangeOwner(null, ME, null)).toBe(true);
    expect(canChangeOwner(null, ME, ME)).toBe(true);
  });

  it("refuses claiming a public resource or handing one away", () => {
    expect(canChangeOwner(ME, ME, null)).toBe(false);
    expect(canChangeOwner(OTHER, ME, ME)).toBe(false);
    expect(canChangeOwner(OTHER, ME, null)).toBe(false);
  });
});

describe("creating for another user is refused before any write", () => {
  it("API key", async () => {
    await expect(
      apiKeysImplementations.create({ name: "k", user_id: OTHER }, ME),
    ).rejects.toThrow(/Access denied/);
    expect(mocks.createKey).not.toHaveBeenCalled();
  });

  it("namespace", async () => {
    const res = await namespacesImplementations.create(
      { name: "ns", user_id: OTHER },
      ME,
    );
    expect(res.success).toBe(false);
    expect(mocks.createNamespace).not.toHaveBeenCalled();
  });

  it("endpoint", async () => {
    // A public namespace, so only the owner check can stop it.
    mocks.findEndpointByName.mockResolvedValue(undefined);
    mocks.findNamespace.mockResolvedValue({ uuid: NS, user_id: null });
    mocks.createEndpoint.mockResolvedValue({ uuid: EP, name: "ep" });
    const res = await endpointsImplementations.create(
      endpointInput({ name: "ep", namespaceUuid: NS, user_id: OTHER }),
      ME,
    );
    expect(res.success).toBe(false);
    expect(mocks.createEndpoint).not.toHaveBeenCalled();
  });

  it("MCP server", async () => {
    const res = await mcpServersImplementations.create(
      {
        name: "srv",
        type: "STREAMABLE_HTTP",
        url: "https://x",
        user_id: OTHER,
      },
      ME,
    );
    expect(res.success).toBe(false);
    expect(mocks.createServer).not.toHaveBeenCalled();
  });
});

describe("updating ownership to another user is refused", () => {
  it("namespace (public, so editable by any user)", async () => {
    mocks.findNamespace.mockResolvedValue({ uuid: NS, user_id: null });
    const res = await namespacesImplementations.update(
      { uuid: NS, name: "ns", user_id: OTHER },
      ME,
    );
    expect(res.success).toBe(false);
    expect(mocks.updateNamespace).not.toHaveBeenCalled();
  });

  it("claiming a public namespace for yourself", async () => {
    mocks.findNamespace.mockResolvedValue({ uuid: NS, user_id: null });
    const res = await namespacesImplementations.update(
      { uuid: NS, name: "ns", user_id: ME },
      ME,
    );
    expect(res.success).toBe(false);
    expect(mocks.updateNamespace).not.toHaveBeenCalled();
  });

  it("claiming a public MCP server for yourself", async () => {
    mocks.findServer.mockResolvedValue({ uuid: SRV, user_id: null });
    const res = await mcpServersImplementations.update(
      { uuid: SRV, name: "srv", type: "STREAMABLE_HTTP", user_id: ME },
      ME,
    );
    expect(res.success).toBe(false);
    expect(mocks.updateServer).not.toHaveBeenCalled();
  });

  it("MCP server (public, so editable by any user)", async () => {
    mocks.findServer.mockResolvedValue({ uuid: SRV, user_id: null });
    const res = await mcpServersImplementations.update(
      { uuid: SRV, name: "srv", type: "STREAMABLE_HTTP", user_id: OTHER },
      ME,
    );
    expect(res.success).toBe(false);
    expect(mocks.updateServer).not.toHaveBeenCalled();
  });
});

describe("own and public ownership keep working", () => {
  it("API key for the caller and a public one", async () => {
    mocks.createKey.mockResolvedValue({ uuid: "k", key: "sk" });
    await apiKeysImplementations.create({ name: "a", user_id: ME }, ME);
    await apiKeysImplementations.create({ name: "b", user_id: null }, ME);
    expect(mocks.createKey).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ user_id: ME }),
    );
    expect(mocks.createKey).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ user_id: null }),
    );
  });
});

describe("endpoint auto-generated MCP server", () => {
  it("gets a fresh key scoped to the new endpoint as its bearer", async () => {
    mocks.findEndpointByName.mockResolvedValue(undefined);
    mocks.findNamespace.mockResolvedValue({ uuid: NS, user_id: ME });
    mocks.createEndpoint.mockResolvedValue({ uuid: EP, name: "infra" });
    mocks.createKey.mockResolvedValue({ uuid: "k", key: "sk_mt_scoped" });
    mocks.createServer.mockResolvedValue({ uuid: SRV });

    const res = await endpointsImplementations.create(
      endpointInput({
        name: "infra",
        namespaceUuid: NS,
        enableApiKeyAuth: true,
        createMcpServer: true,
      }),
      ME,
    );

    expect(res.success).toBe(true);
    expect(mocks.createKey).toHaveBeenCalledTimes(1);
    expect(mocks.createKey).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: ME, endpoint_uuid: EP }),
    );
    expect(mocks.createServer).toHaveBeenCalledWith(
      expect.objectContaining({ bearerToken: "sk_mt_scoped" }),
    );
  });
});
