import type { AddressInfo } from "node:net";

import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The admin API acts on every MCP server, so an endpoint-scoped key must be
// refused before any handler runs.

const mocks = vi.hoisted(() => ({
  findAll: vi.fn(async () => []),
}));

vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/middleware/lookup-endpoint-middleware", () => ({
  lookupEndpoint: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

vi.mock("@/middleware/api-key-oauth.middleware", () => ({
  authenticateApiKey: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const scope = req.headers["x-test-scope"];
    if (scope) {
      (req as unknown as { apiKeyEndpointUuid: string }).apiKeyEndpointUuid =
        scope as string;
    }
    next();
  },
}));

vi.mock("../../db/repositories", () => ({
  mcpServersRepository: { findAll: mocks.findAll },
}));

vi.mock("../../lib/metamcp/server-error-tracker", () => ({
  serverErrorTracker: {
    resetServerErrorState: vi.fn(),
    resetAllAttempts: vi.fn(),
  },
}));

vi.mock("../../lib/startup", () => ({
  initializeIdleServers: vi.fn(async () => undefined),
}));

import adminRouter from "./admin";

describe("admin router with endpoint-scoped keys", () => {
  let baseUrl: string;
  let server: ReturnType<express.Express["listen"]>;

  beforeAll(async () => {
    const app = express();
    app.use(adminRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("refuses error-status and reset-errors for a scoped key", async () => {
    const headers = { "x-test-scope": "ep-infra" };
    const status = await fetch(`${baseUrl}/infra/admin/error-status`, {
      headers,
    });
    const reset = await fetch(`${baseUrl}/infra/admin/reset-errors`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}",
    });
    expect(status.status).toBe(403);
    expect(reset.status).toBe(403);
    expect(mocks.findAll).not.toHaveBeenCalled();
  });

  it("keeps the admin API for unscoped keys", async () => {
    const res = await fetch(`${baseUrl}/infra/admin/error-status`);
    expect(res.status).toBe(200);
  });
});
