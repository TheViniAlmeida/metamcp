import { beforeEach, describe, expect, it, vi } from "vitest";

// A pooled connection keeps its transport for hours, longer than the
// upstream access token lives. The live-token fetch must send the current
// token, refresh it before expiry (Titan never answers 401, it reports
// UnAuthorizedAccess inside a 200), and refresh once on a 401.

const mocks = vi.hoisted(() => ({
  findByMcpServerUuid: vi.fn(),
  tryRefreshUpstreamTokens: vi.fn(),
  log: vi.fn(),
}));

vi.mock("../../db/repositories", () => ({
  oauthSessionsRepository: {
    findByMcpServerUuid: mocks.findByMcpServerUuid,
  },
}));

vi.mock("./refresh-on-401", () => ({
  tryRefreshUpstreamTokens: mocks.tryRefreshUpstreamTokens,
}));

vi.mock("../../utils/logger", () => ({
  default: { info: mocks.log, warn: mocks.log, error: mocks.log },
}));

import {
  createLiveTokenFetch,
  REFRESH_SKEW_MS,
  RETRY_COOLDOWN_MS,
  tokenExpiresAt,
} from "./live-token-fetch";

const SERVER = {
  uuid: "00000000-0000-0000-0000-0000000000aa",
  name: "titan",
  url: "https://mcp.example.com/mcp",
};
const T0 = Date.parse("2026-11-04T02:00:00Z");
const HOUR = 3600;

const session = (accessToken: string, updatedAt: number, refresh = true) => ({
  mcp_server_uuid: SERVER.uuid,
  tokens: {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: HOUR,
    ...(refresh && { refresh_token: "RT" }),
  },
  updated_at: new Date(updatedAt),
});

// Fake clock shared by `setup` and `refreshed`, like the real refresh that
// stamps `obtained_at` when the token response arrives.
let clock = T0;

const refreshed = (accessToken: string) => ({
  status: "refreshed",
  tokens: {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: HOUR,
    obtained_at: clock / 1000,
  },
});

const setup = (status = 200) => {
  clock = T0;
  const sent: string[] = [];
  const base = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    sent.push(new Headers(init?.headers).get("Authorization") ?? "");
    return new Response("{}", { status });
  });
  const liveFetch = createLiveTokenFetch(SERVER, "OLD", base, () => clock);
  return {
    liveFetch,
    base,
    sent,
    advance: (ms: number) => {
      clock += ms;
    },
    at: (ms: number) => {
      clock = ms;
    },
  };
};

const post = (body = '{"jsonrpc":"2.0","id":1,"method":"tools/call"}') => ({
  method: "POST",
  headers: { Authorization: "Bearer STALE-STATIC", "mcp-session-id": "s1" },
  body,
});

beforeEach(() => {
  mocks.findByMcpServerUuid.mockReset();
  mocks.tryRefreshUpstreamTokens.mockReset();
  mocks.log.mockReset();
  clock = T0;
});

describe("createLiveTokenFetch", () => {
  it("sends the stored token while it is fresh, without refreshing", async () => {
    mocks.findByMcpServerUuid.mockResolvedValue(session("OLD", T0));
    const { liveFetch, sent, base } = setup();

    await liveFetch(SERVER.url, post());
    await liveFetch(SERVER.url, post());

    expect(sent).toEqual(["Bearer OLD", "Bearer OLD"]);
    expect(mocks.tryRefreshUpstreamTokens).not.toHaveBeenCalled();
    // Expiry is read once; later fresh requests do not touch the DB.
    expect(mocks.findByMcpServerUuid).toHaveBeenCalledTimes(1);
    // Other headers pass through untouched.
    const init = base.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("mcp-session-id")).toBe("s1");
  });

  it("refreshes before expiry and keeps the new token", async () => {
    mocks.findByMcpServerUuid.mockResolvedValue(session("OLD", T0));
    mocks.tryRefreshUpstreamTokens.mockImplementation(async () =>
      refreshed("NEW"),
    );
    const { liveFetch, sent, at, advance } = setup();

    await liveFetch(SERVER.url, post());
    at(T0 + HOUR * 1000 - REFRESH_SKEW_MS + 1);
    await liveFetch(SERVER.url, post());
    advance(10 * 60 * 1000);
    await liveFetch(SERVER.url, post());

    expect(sent).toEqual(["Bearer OLD", "Bearer NEW", "Bearer NEW"]);
    expect(mocks.tryRefreshUpstreamTokens).toHaveBeenCalledTimes(1);
  });

  it("refreshes a token that had already expired when the connection was made", async () => {
    mocks.findByMcpServerUuid.mockResolvedValue(
      session("OLD", T0 - 2 * HOUR * 1000),
    );
    mocks.tryRefreshUpstreamTokens.mockImplementation(async () =>
      refreshed("NEW"),
    );
    const { liveFetch, sent } = setup();

    await liveFetch(SERVER.url, post());

    expect(sent).toEqual(["Bearer NEW"]);
  });

  it("uses a token another path already refreshed instead of refreshing again", async () => {
    mocks.findByMcpServerUuid
      .mockResolvedValueOnce(session("OLD", T0))
      .mockResolvedValueOnce(session("OTHER", T0 + HOUR * 1000));
    const { liveFetch, sent, at } = setup();

    await liveFetch(SERVER.url, post());
    at(T0 + HOUR * 1000);
    await liveFetch(SERVER.url, post());

    expect(sent).toEqual(["Bearer OLD", "Bearer OTHER"]);
    expect(mocks.tryRefreshUpstreamTokens).not.toHaveBeenCalled();
  });

  it("shares one refresh between concurrent requests", async () => {
    mocks.findByMcpServerUuid.mockResolvedValue(
      session("OLD", T0 - 2 * HOUR * 1000),
    );
    mocks.tryRefreshUpstreamTokens.mockImplementation(async () =>
      refreshed("NEW"),
    );
    const { liveFetch, sent } = setup();

    await Promise.all([
      liveFetch(SERVER.url, post()),
      liveFetch(SERVER.url, post()),
      liveFetch(SERVER.url, post()),
    ]);

    expect(sent).toEqual(["Bearer NEW", "Bearer NEW", "Bearer NEW"]);
    expect(mocks.tryRefreshUpstreamTokens).toHaveBeenCalledTimes(1);
  });

  it("keeps the current token and backs off when the refresh fails", async () => {
    mocks.findByMcpServerUuid.mockResolvedValue(
      session("OLD", T0 - 2 * HOUR * 1000),
    );
    mocks.tryRefreshUpstreamTokens.mockResolvedValue({
      status: "failed",
      error: "invalid_grant",
    });
    const { liveFetch, sent, advance } = setup();

    await liveFetch(SERVER.url, post());
    await liveFetch(SERVER.url, post());
    expect(mocks.tryRefreshUpstreamTokens).toHaveBeenCalledTimes(1);

    advance(RETRY_COOLDOWN_MS);
    await liveFetch(SERVER.url, post());

    expect(sent).toEqual(["Bearer OLD", "Bearer OLD", "Bearer OLD"]);
    expect(mocks.tryRefreshUpstreamTokens).toHaveBeenCalledTimes(2);
  });

  it("re-reads an expired session without refresh_token at most once per cooldown", async () => {
    mocks.findByMcpServerUuid.mockResolvedValue(
      session("OLD", T0 - 2 * HOUR * 1000, false),
    );
    const { liveFetch, advance } = setup();

    await liveFetch(SERVER.url, post());
    await liveFetch(SERVER.url, post());
    await liveFetch(SERVER.url, post());
    expect(mocks.findByMcpServerUuid).toHaveBeenCalledTimes(1);

    advance(RETRY_COOLDOWN_MS);
    await liveFetch(SERVER.url, post());
    expect(mocks.findByMcpServerUuid).toHaveBeenCalledTimes(2);
  });

  it("dates a reused stored token from the session, not from now", async () => {
    mocks.findByMcpServerUuid
      .mockResolvedValueOnce(session("OLD", T0 - 2 * HOUR * 1000))
      .mockResolvedValue(session("OTHER", T0 - 50 * 60 * 1000));
    mocks.tryRefreshUpstreamTokens.mockResolvedValue({
      status: "refreshed",
      tokens: { access_token: "OTHER", token_type: "Bearer", expires_in: HOUR },
    });
    const { liveFetch, sent, at } = setup();

    await liveFetch(SERVER.url, post());
    // OTHER was stored 50 min before T0, so it is due for refresh at T0+5.
    mocks.tryRefreshUpstreamTokens.mockImplementation(async () =>
      refreshed("NEW"),
    );
    at(T0 + 6 * 60 * 1000);
    await liveFetch(SERVER.url, post());

    expect(sent).toEqual(["Bearer OTHER", "Bearer NEW"]);
  });

  it("never refreshes proactively without a refresh_token", async () => {
    mocks.findByMcpServerUuid.mockResolvedValue(
      session("OLD", T0 - 2 * HOUR * 1000, false),
    );
    const { liveFetch, sent } = setup();

    await liveFetch(SERVER.url, post());

    expect(sent).toEqual(["Bearer OLD"]);
    expect(mocks.tryRefreshUpstreamTokens).not.toHaveBeenCalled();
  });

  it("refreshes once on 401 and retries the request with the new token", async () => {
    mocks.findByMcpServerUuid.mockResolvedValue(session("OLD", T0));
    mocks.tryRefreshUpstreamTokens.mockImplementation(async () =>
      refreshed("NEW"),
    );
    const sent: string[] = [];
    const bodies: unknown[] = [];
    const base = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      sent.push(auth);
      bodies.push(init?.body);
      return new Response("{}", { status: auth === "Bearer OLD" ? 401 : 200 });
    });
    const liveFetch = createLiveTokenFetch(SERVER, "OLD", base, () => T0);

    const res = await liveFetch(SERVER.url, post("BODY"));

    expect(res.status).toBe(200);
    expect(sent).toEqual(["Bearer OLD", "Bearer NEW"]);
    expect(bodies).toEqual(["BODY", "BODY"]);
    expect(mocks.tryRefreshUpstreamTokens).toHaveBeenCalledTimes(1);
  });

  it("returns the 401 when the refresh does not produce a new token", async () => {
    mocks.findByMcpServerUuid.mockResolvedValue(session("OLD", T0));
    mocks.tryRefreshUpstreamTokens.mockResolvedValue({ status: "failed" });
    const { liveFetch, sent } = setup(401);

    const res = await liveFetch(SERVER.url, post());
    const again = await liveFetch(SERVER.url, post());

    expect(res.status).toBe(401);
    expect(again.status).toBe(401);
    expect(sent).toEqual(["Bearer OLD", "Bearer OLD"]);
    // The cooldown stops a refresh per request.
    expect(mocks.tryRefreshUpstreamTokens).toHaveBeenCalledTimes(1);
  });

  it("still sends the request when the session lookup throws", async () => {
    mocks.findByMcpServerUuid.mockRejectedValue(new Error("db down"));
    const { liveFetch, sent } = setup();

    const res = await liveFetch(SERVER.url, post());

    expect(res.status).toBe(200);
    expect(sent).toEqual(["Bearer OLD"]);
  });

  it("dates the token by obtained_at, not by a later updated_at", async () => {
    // Token obtained at T0; an abandoned re-authorization bumped updated_at
    // 50 minutes later.
    mocks.findByMcpServerUuid.mockResolvedValue({
      ...session("OLD", T0 + 50 * 60 * 1000),
      tokens: {
        ...session("OLD", T0).tokens,
        obtained_at: T0 / 1000,
      },
    });
    mocks.tryRefreshUpstreamTokens.mockImplementation(async () =>
      refreshed("NEW"),
    );
    const { liveFetch, sent, at } = setup();

    at(T0 + 56 * 60 * 1000);
    await liveFetch(SERVER.url, post());

    expect(sent).toEqual(["Bearer NEW"]);
    expect(mocks.tryRefreshUpstreamTokens).toHaveBeenCalledWith(SERVER, "OLD");
  });

  it("reads expiry once and never refreshes proactively without expires_in", async () => {
    mocks.findByMcpServerUuid.mockResolvedValue({
      ...session("OLD", T0 - 10 * HOUR * 1000),
      tokens: {
        access_token: "OLD",
        token_type: "Bearer",
        refresh_token: "RT",
      },
    });
    const { liveFetch, sent } = setup();

    await liveFetch(SERVER.url, post());
    await liveFetch(SERVER.url, post());

    expect(sent).toEqual(["Bearer OLD", "Bearer OLD"]);
    expect(mocks.findByMcpServerUuid).toHaveBeenCalledTimes(1);
    expect(mocks.tryRefreshUpstreamTokens).not.toHaveBeenCalled();
  });

  it("on 401 uses a token another connection already stored", async () => {
    mocks.findByMcpServerUuid
      .mockResolvedValueOnce(session("OLD", T0))
      .mockResolvedValueOnce(session("OTHER", T0 + 1000));
    const sent: string[] = [];
    const base = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      sent.push(auth);
      return new Response("{}", { status: auth === "Bearer OLD" ? 401 : 200 });
    });
    const liveFetch = createLiveTokenFetch(SERVER, "OLD", base, () => T0);

    const res = await liveFetch(SERVER.url, post());

    expect(res.status).toBe(200);
    expect(sent).toEqual(["Bearer OLD", "Bearer OTHER"]);
    expect(mocks.tryRefreshUpstreamTokens).not.toHaveBeenCalled();
  });

  it("shares one 401 refresh between concurrent requests", async () => {
    mocks.findByMcpServerUuid.mockResolvedValue(session("OLD", T0));
    mocks.tryRefreshUpstreamTokens.mockImplementation(async () =>
      refreshed("NEW"),
    );
    const sent: string[] = [];
    const base = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      sent.push(auth);
      return new Response("{}", { status: auth === "Bearer OLD" ? 401 : 200 });
    });
    const liveFetch = createLiveTokenFetch(SERVER, "OLD", base, () => T0);

    const statuses = await Promise.all(
      [1, 2, 3].map(async () => (await liveFetch(SERVER.url, post())).status),
    );

    expect(statuses).toEqual([200, 200, 200]);
    expect(mocks.tryRefreshUpstreamTokens).toHaveBeenCalledTimes(1);
    expect(sent.filter((h) => h === "Bearer NEW")).toHaveLength(3);
  });

  it("checks the session again once the database is back", async () => {
    mocks.findByMcpServerUuid.mockRejectedValueOnce(new Error("db down"));
    mocks.findByMcpServerUuid.mockResolvedValue(session("STORED", T0));
    const { liveFetch, sent, advance } = setup();

    await liveFetch(SERVER.url, post());
    await liveFetch(SERVER.url, post());
    advance(RETRY_COOLDOWN_MS);
    await liveFetch(SERVER.url, post());

    expect(sent).toEqual(["Bearer OLD", "Bearer OLD", "Bearer STORED"]);
    expect(mocks.findByMcpServerUuid).toHaveBeenCalledTimes(2);
  });

  it("never writes token values to the log", async () => {
    mocks.findByMcpServerUuid.mockResolvedValue(
      session("OLD", T0 - 2 * HOUR * 1000),
    );
    mocks.tryRefreshUpstreamTokens.mockRejectedValue(
      new Error('Failed query\nparams: {"access_token":"SECRET"}'),
    );
    const { liveFetch } = setup(401);

    await liveFetch(SERVER.url, post());

    expect(mocks.log).toHaveBeenCalled();
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain("SECRET");
  });
});

describe("tokenExpiresAt", () => {
  it("accepts a numeric string expires_in", () => {
    expect(tokenExpiresAt({ expires_in: "3600" }, T0)).toBe(T0 + HOUR * 1000);
  });

  it("prefers obtained_at over the fallback timestamp", () => {
    expect(
      tokenExpiresAt({ expires_in: HOUR, obtained_at: T0 / 1000 }, T0 + 99999),
    ).toBe(T0 + HOUR * 1000);
  });

  it("is undefined without a usable expires_in", () => {
    expect(tokenExpiresAt({}, T0)).toBeUndefined();
    expect(tokenExpiresAt({ expires_in: 0 }, T0)).toBeUndefined();
    expect(tokenExpiresAt({ expires_in: "soon" }, T0)).toBeUndefined();
  });
});
