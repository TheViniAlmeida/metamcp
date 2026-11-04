import type { AddressInfo } from "node:net";

import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// GET /metamcp/ needs no credential, so it must not enumerate endpoint names,
// descriptions or namespaces.

vi.mock("./public-metamcp/admin", () => ({ default: express.Router() }));
vi.mock("./public-metamcp/openapi", () => ({
  openApiRouter: express.Router(),
}));
vi.mock("./public-metamcp/sse", () => ({ default: express.Router() }));
vi.mock("./public-metamcp/streamable-http", () => ({
  default: express.Router(),
}));

vi.mock("../db/repositories/endpoints.repo", () => ({
  endpointsRepository: {
    findAllWithNamespaces: vi.fn(async () => [
      {
        name: "infra",
        description: "secret world",
        namespace: { name: "infra" },
      },
    ]),
  },
}));

import publicEndpointsRouter from "./public-metamcp";

describe("public endpoints index", () => {
  let baseUrl: string;
  let server: ReturnType<express.Express["listen"]>;

  beforeAll(async () => {
    const app = express();
    app.use("/metamcp", publicEndpointsRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("returns service info without listing endpoints", async () => {
    const res = await fetch(`${baseUrl}/metamcp/`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.service).toBe("public-endpoints");
    expect(body).not.toHaveProperty("endpoints");
  });
});
