import type { AddressInfo } from "node:net";

import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Router-level proof that a public-endpoint session only works through the
// endpoint and credential that opened it (Streamable HTTP and SSE), and that
// session IDs are not exposed in error, cleanup or health responses.

const handled = vi.hoisted(() => ({
  http: [] as string[],
  sse: [] as string[],
  sseCount: 0,
}));

vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../lib/config.service", () => ({
  configService: { getSessionLifetime: async () => null },
}));

vi.mock("@/middleware/lookup-endpoint-middleware", () => ({
  lookupEndpoint: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const name = req.params.endpoint_name;
    Object.assign(req, {
      endpoint: { uuid: `ep-${name}`, user_id: "u1" },
      endpointName: name,
      namespaceUuid: `ns-${name}`,
    });
    next();
  },
}));

vi.mock("@/middleware/api-key-oauth.middleware", () => ({
  authenticateApiKey: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const key = req.headers["x-api-key"];
    if (key) Object.assign(req, { apiKeyUuid: key, authMethod: "api_key" });
    const oauth = req.headers["x-oauth"];
    if (oauth) Object.assign(req, { oauthUserId: oauth, authMethod: "oauth" });
    next();
  },
}));

vi.mock("@/middleware/rate-limit.middleware", () => ({
  rateLimitMiddleware: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

vi.mock("../../lib/admin-mcp/build-admin-tools-options", () => ({
  buildAdminToolsOptions: async () => undefined,
}));

vi.mock("../../lib/metamcp/header-forwarding", () => ({
  extractClientHeaders: () => ({}),
}));

vi.mock("../../lib/metamcp/metamcp-server-pool", () => ({
  metaMcpServerPool: {
    getServer: async () => ({ server: { connect: async () => undefined } }),
    cleanupSession: async () => undefined,
    getPoolStatus: () => ({
      idle: 0,
      active: 1,
      activeSessionIds: ["LEAKED-SESSION-ID"],
      idleNamespaceUuids: ["LEAKED-NAMESPACE"],
    }),
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: class {
    id: string;
    constructor(opts: { sessionIdGenerator: () => string }) {
      this.id = opts.sessionIdGenerator();
    }
    async handleRequest(_req: express.Request, res: express.Response) {
      handled.http.push(this.id);
      res.setHeader("mcp-session-id", this.id);
      res.status(200).json({ session: this.id });
    }
    async close() {}
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/sse.js", () => ({
  SSEServerTransport: class {
    sessionId: string;
    constructor(_path: string, res: express.Response) {
      this.sessionId = `sse-${++handled.sseCount}`;
      // Send headers but keep the stream open, like a real SSE connection.
      res.writeHead(200, { "x-sid": this.sessionId });
      res.flushHeaders();
    }
    async handlePostMessage(_req: express.Request, res: express.Response) {
      handled.sse.push(this.sessionId);
      res.status(202).end();
    }
    async close() {}
  },
}));

import sseRouter from "./sse";
import streamableHttpRouter from "./streamable-http";

let base = "";
let server: ReturnType<express.Express["listen"]>;

beforeAll(async () => {
  const app = express();
  app.use(streamableHttpRouter);
  app.use(sseRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const intruders = [
  ["eq", { "x-api-key": "key-eq" }], // other endpoint, its own key
  ["eq", { "x-api-key": "key-infra" }], // other endpoint, same key
  ["infra", { "x-api-key": "key-eq" }], // same endpoint, other key
  ["infra", { "x-oauth": "u1" }], // same endpoint, OAuth as the owner user
] as const;

describe("Streamable HTTP session binding", () => {
  const call = (method: string, ep: string, headers: Record<string, string>) =>
    fetch(`${base}/${ep}/mcp`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: method === "POST" ? "{}" : undefined,
    });

  it("only the endpoint and key that opened a session can use it", async () => {
    const owner = { "x-api-key": "key-infra" };
    const open = await call("POST", "infra", owner);
    expect(open.status).toBe(200);
    const sid = open.headers.get("mcp-session-id") as string;

    for (const [ep, headers] of intruders) {
      for (const method of ["POST", "GET", "DELETE"]) {
        const res = await call(method, ep, {
          ...headers,
          "mcp-session-id": sid,
        });
        expect([method, ep, res.status]).toEqual([method, ep, 404]);
        expect(await res.text()).not.toContain("available_sessions");
      }
    }
    expect(handled.http).toEqual([sid]);

    const withSid = { ...owner, "mcp-session-id": sid };
    expect((await call("POST", "infra", withSid)).status).toBe(200);
    expect((await call("GET", "infra", withSid)).status).toBe(200);
    const del = await call("DELETE", "infra", withSid);
    expect(del.status).toBe(200);
    expect(await del.text()).not.toContain("remainingSessions");
    expect((await call("POST", "infra", withSid)).status).toBe(404);
  });

  it("does not list sessions in the 404 body", async () => {
    const open = await call("POST", "infra", { "x-api-key": "key-infra" });
    const sid = open.headers.get("mcp-session-id") as string;
    const res = await call("POST", "eq", {
      "x-api-key": "key-eq",
      "mcp-session-id": "does-not-exist",
    });
    const body = await res.text();
    expect(res.status).toBe(404);
    expect(body).not.toContain("available_sessions");
    expect(body).not.toContain(sid);
  });

  it("health/sessions exposes counts only", async () => {
    const body = await (await fetch(`${base}/health/sessions`)).text();
    expect(body).not.toContain("LEAKED-SESSION-ID");
    expect(body).not.toContain("LEAKED-NAMESPACE");
    expect(body).not.toContain("sessionIds");
    expect(JSON.parse(body).streamableHttpSessions.count).toBeGreaterThan(0);
  });
});

describe("SSE session binding", () => {
  it("only the endpoint and key that opened the stream can post to it", async () => {
    const stream = new AbortController();
    const open = await fetch(`${base}/infra/sse`, {
      headers: { "x-api-key": "key-infra" },
      signal: stream.signal,
    });
    expect(open.status).toBe(200);
    const sid = open.headers.get("x-sid") as string;

    const post = (ep: string, headers: Record<string, string>) =>
      fetch(`${base}/${ep}/message?sessionId=${sid}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: "{}",
      });

    for (const [ep, headers] of intruders) {
      expect([ep, (await post(ep, headers)).status]).toEqual([ep, 404]);
    }
    expect(handled.sse).toEqual([]);

    expect((await post("infra", { "x-api-key": "key-infra" })).status).toBe(
      202,
    );
    expect(handled.sse).toEqual([sid]);
    stream.abort();
  });
});
