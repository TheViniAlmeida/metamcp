import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiKeysTable } from "../db/schema";

// BOOTSTRAP_RECREATE_USER deletes the user (and with it the user's endpoints)
// and restores the preserved API keys. An endpoint-scoped key must not come
// back: without its endpoint it would be restored as an account-wide key.

const state = vi.hoisted(() => ({
  preserved: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<{ table: unknown; values: unknown }>,
}));

vi.mock("../auth", () => ({
  auth: { handler: vi.fn(async () => new Response("{}", { status: 200 })) },
}));

vi.mock("../db", async () => {
  const { apiKeysTable: keys } = await import("../db/schema");
  // Chainable stand-in for drizzle: every builder method returns the chain
  // and awaiting it yields `result`.
  const chain = (result: unknown): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (resolve: (v: unknown) => void) => resolve(result);
          }
          return () => chain(result);
        },
      },
    );
  return {
    db: {
      query: new Proxy(
        {},
        {
          get: (_t, table) => ({
            findFirst: async () =>
              table === "usersTable"
                ? { id: "user-1", email: "op@example.com" }
                : undefined,
          }),
        },
      ),
      select: () => ({
        from: (table: unknown) => chain(table === keys ? state.preserved : []),
      }),
      insert: (table: unknown) => ({
        values: (values: unknown) => {
          state.inserts.push({ table, values });
          return chain([]);
        },
      }),
      delete: () => chain([]),
      update: () => chain([]),
    },
  };
});

import { initializeEnvironmentConfiguration } from "./bootstrap.service";

const ENV = {
  BOOTSTRAP_USER_EMAIL: "op@example.com",
  BOOTSTRAP_USER_PASSWORD: "not-a-real-password",
  BOOTSTRAP_RECREATE_USER: "true",
  BOOTSTRAP_PRESERVE_API_KEYS: "true",
};

describe("bootstrap user recreation with endpoint-scoped keys", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
    state.inserts.length = 0;
    state.preserved = [
      {
        name: "all",
        key: "sk_mt_all",
        is_active: true,
        endpoint_uuid: null,
      },
      {
        name: "metamcp-infra",
        key: "sk_mt_infra",
        is_active: true,
        endpoint_uuid: "11111111-1111-4111-8111-111111111111",
      },
    ];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("restores the unscoped key and drops the scoped one", async () => {
    await initializeEnvironmentConfiguration();

    const restored = state.inserts
      .filter((i) => i.table === apiKeysTable)
      .map((i) => i.values as { name: string; key: string });

    expect(restored.map((k) => k.name)).toEqual(["all"]);
    expect(restored.some((k) => k.key === "sk_mt_infra")).toBe(false);
  });
});
