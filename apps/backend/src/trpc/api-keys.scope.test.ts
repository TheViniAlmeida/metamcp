import { beforeEach, describe, expect, it, vi } from "vitest";

// Creating an endpoint-scoped key must fail closed unless the endpoint exists
// and has the same owner as the key.

const mocks = vi.hoisted(() => ({
  createKey: vi.fn(),
  findEndpoint: vi.fn(),
}));

vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../db/repositories", () => ({
  ApiKeysRepository: class {
    create = mocks.createKey;
  },
  endpointsRepository: { findByUuid: mocks.findEndpoint },
}));

vi.mock("../db/serializers", () => ({
  ApiKeysSerializer: { serializeCreateApiKeyResponse: (x: unknown) => x },
}));

import { apiKeysImplementations } from "./api-keys.impl";

const EP = "11111111-1111-4111-8111-111111111111";

describe("apiKeysImplementations.create with endpoint scope", () => {
  beforeEach(() => {
    mocks.createKey.mockReset().mockResolvedValue({ uuid: "k", key: "sk" });
    mocks.findEndpoint.mockReset();
  });

  it("creates a private key scoped to the caller's own endpoint", async () => {
    mocks.findEndpoint.mockResolvedValue({ uuid: EP, user_id: "user-1" });
    await apiKeysImplementations.create(
      { name: "infra", endpoint_uuid: EP },
      "user-1",
    );
    expect(mocks.createKey).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: "user-1", endpoint_uuid: EP }),
    );
  });

  it("rejects a missing endpoint", async () => {
    mocks.findEndpoint.mockResolvedValue(undefined);
    await expect(
      apiKeysImplementations.create({ name: "x", endpoint_uuid: EP }, "user-1"),
    ).rejects.toThrow(/Endpoint not found/);
    expect(mocks.createKey).not.toHaveBeenCalled();
  });

  it("rejects an endpoint owned by someone else", async () => {
    mocks.findEndpoint.mockResolvedValue({ uuid: EP, user_id: "user-2" });
    await expect(
      apiKeysImplementations.create({ name: "x", endpoint_uuid: EP }, "user-1"),
    ).rejects.toThrow(/Endpoint not found/);
    expect(mocks.createKey).not.toHaveBeenCalled();
  });

  it("rejects a public key scoped to a private endpoint", async () => {
    mocks.findEndpoint.mockResolvedValue({ uuid: EP, user_id: "user-1" });
    await expect(
      apiKeysImplementations.create(
        { name: "x", user_id: null, endpoint_uuid: EP },
        "user-1",
      ),
    ).rejects.toThrow(/Endpoint not found/);
    expect(mocks.createKey).not.toHaveBeenCalled();
  });

  it("keeps unscoped creation unchanged", async () => {
    await apiKeysImplementations.create({ name: "all" }, "user-1");
    expect(mocks.findEndpoint).not.toHaveBeenCalled();
    expect(mocks.createKey).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: "user-1", endpoint_uuid: null }),
    );
  });
});
