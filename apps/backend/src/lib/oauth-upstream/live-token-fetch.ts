// Fetch wrapper that keeps an upstream OAuth access token fresh for the
// lifetime of a pooled connection.
//
// The MCP transports are built once with a static `Authorization` header and
// then reused for hours. Refresh-on-401 (`client.ts`) only runs while
// connecting, so a token that expires mid-session is never replaced. Some
// upstreams make this worse by not answering 401 at all: Titan accepts
// `initialize` and `tools/list` with an expired token and reports
// `UnAuthorizedAccess` inside the tool result with HTTP 200.
//
// This wrapper sets the bearer on every request from a cached token and:
//   - refreshes it shortly before it expires (proactive);
//   - on a 401, picks up a token another connection already stored, or
//     refreshes once, and retries the request (reactive).
//
// Expiry is `obtained_at + expires_in` (`obtained_at` is stamped by
// `token-exchange.ts` on every server-side token response). Tokens stored
// before that stamp existed fall back to the session's `updated_at`, which
// can run late because other writes bump it too. Tokens without
// `expires_in` are only refreshed on 401.

import { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ServerParameters } from "@repo/zod-types";

import { oauthSessionsRepository } from "../../db/repositories";
import logger from "../../utils/logger";
import { tryRefreshUpstreamTokens } from "./refresh-on-401";

// Refresh this long before the estimated expiry.
export const REFRESH_SKEW_MS = 5 * 60 * 1000;
// After a failed refresh or session lookup, keep using the current token
// for this long before trying again, so a dead refresh_token or a database
// outage does not cost a lookup and a token POST on every request.
export const RETRY_COOLDOWN_MS = 60 * 1000;

interface CachedToken {
  accessToken: string;
  expiresAt?: number;
}

type ServerRef = Pick<ServerParameters, "uuid" | "name" | "url">;

interface StoredTokens {
  access_token?: unknown;
  expires_in?: unknown;
  obtained_at?: unknown;
  refresh_token?: unknown;
}

const positiveNumber = (value: unknown): number | undefined => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
};

// Expiry in ms, or undefined when the token does not say how long it lives.
export const tokenExpiresAt = (
  tokens: StoredTokens,
  fallbackIssuedAtMs: number,
): number | undefined => {
  const expiresIn = positiveNumber(tokens.expires_in);
  if (expiresIn === undefined) {
    return undefined;
  }
  const obtainedAt = positiveNumber(tokens.obtained_at);
  const issuedAtMs =
    obtainedAt !== undefined ? obtainedAt * 1000 : fallbackIssuedAtMs;
  return issuedAtMs + expiresIn * 1000;
};

// Never log the error object: database errors embed the query parameters,
// which include the tokens.
const errorName = (error: unknown) =>
  error instanceof Error ? error.name : typeof error;

export function createLiveTokenFetch(
  serverParams: ServerRef,
  initialAccessToken: string,
  baseFetch: FetchLike = fetch,
  now: () => number = Date.now,
): FetchLike {
  const label = `${serverParams.name} (${serverParams.uuid})`;
  let cached: CachedToken = { accessToken: initialAccessToken };
  // The initial token comes from serverParams without a timestamp; its
  // expiry is read from the stored session on the first request.
  let expiryKnown = false;
  let hasRefreshToken = false;
  let lastAttemptAt: number | undefined;
  let checking: Promise<void> | undefined;
  let reacting: Promise<void> | undefined;

  const isExpiring = () =>
    cached.expiresAt !== undefined &&
    now() >= cached.expiresAt - REFRESH_SKEW_MS;
  const inCooldown = () =>
    lastAttemptAt !== undefined && now() - lastAttemptAt < RETRY_COOLDOWN_MS;

  // Read the stored token. Another path (another pooled connection, the
  // connect-time refresh, the UI) may already have replaced it.
  const loadStored = async (): Promise<void> => {
    const session = await oauthSessionsRepository.findByMcpServerUuid(
      serverParams.uuid,
    );
    const tokens = (session?.tokens ?? {}) as StoredTokens;
    if (!session || typeof tokens.access_token !== "string") {
      hasRefreshToken = false;
      return;
    }
    cached = {
      accessToken: tokens.access_token,
      expiresAt: tokenExpiresAt(tokens, new Date(session.updated_at).getTime()),
    };
    hasRefreshToken = typeof tokens.refresh_token === "string";
  };

  const refresh = async (reason: string): Promise<void> => {
    const result = await tryRefreshUpstreamTokens(
      serverParams,
      cached.accessToken,
    );
    if (result.status === "refreshed" && result.tokens) {
      if (positiveNumber(result.tokens.obtained_at) === undefined) {
        // Reused a stored token without the stamp: date it from the
        // session row rather than from now.
        await loadStored();
      } else {
        cached = {
          accessToken: result.tokens.access_token,
          expiresAt: tokenExpiresAt(result.tokens, now()),
        };
      }
      lastAttemptAt = undefined;
      logger.info(`[oauth] live token refreshed (${reason}) for ${label}`);
      return;
    }
    lastAttemptAt = now();
    logger.warn(
      `[oauth] live token refresh (${reason}) did not succeed for ${label}: ` +
        `${result.status}${result.error ? ` (${result.error})` : ""}`,
    );
  };

  // Proactive path: on the first request, and whenever the token is close
  // to expiry, re-read the session and refresh if it is still expiring.
  const ensureFresh = async (): Promise<void> => {
    if (expiryKnown && !isExpiring()) {
      return;
    }
    if (inCooldown()) {
      return;
    }
    checking ??= (async () => {
      try {
        await loadStored();
        expiryKnown = true;
        if (hasRefreshToken && isExpiring()) {
          await refresh("expiring");
        } else if (isExpiring()) {
          // Nothing to refresh with: re-read at most once per cooldown in
          // case the UI re-authorizes.
          lastAttemptAt = now();
        }
      } catch (error) {
        lastAttemptAt = now();
        logger.error(
          `[oauth] live token check failed for ${label}: ${errorName(error)}`,
        );
      } finally {
        checking = undefined;
      }
    })();
    await checking;
  };

  // Reactive path: the upstream rejected `tokenUsed`.
  const recoverFrom401 = async (tokenUsed: string): Promise<void> => {
    await checking;
    if (cached.accessToken !== tokenUsed || inCooldown()) {
      return;
    }
    reacting ??= (async () => {
      try {
        await loadStored();
        if (cached.accessToken === tokenUsed) {
          await refresh("401");
        }
      } catch (error) {
        lastAttemptAt = now();
        logger.error(
          `[oauth] live token recovery after 401 failed for ${label}: ${errorName(error)}`,
        );
      } finally {
        reacting = undefined;
      }
    })();
    await reacting;
  };

  const send = (url: string | URL, init: RequestInit | undefined) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${cached.accessToken}`);
    return baseFetch(url, { ...init, headers });
  };

  return async (url, init) => {
    await ensureFresh();
    const tokenUsed = cached.accessToken;
    const response = await send(url, init);
    if (response.status !== 401) {
      return response;
    }
    await recoverFrom401(tokenUsed);
    if (cached.accessToken === tokenUsed) {
      return response;
    }
    await response.body?.cancel();
    return send(url, init);
  };
}
