import type { ApiKeyAuthenticatedRequest } from "@/middleware/api-key-oauth.middleware";

/**
 * Binds a public-endpoint session to the endpoint and credential that opened
 * it. Transports are looked up by session ID alone, so without this a session
 * ID learned elsewhere could be replayed through another endpoint or key and
 * run in the namespace (and admin context) of whoever opened the session.
 */
export class SessionOwnerRegistry {
  private owners = new Map<string, string>();

  private static ownerOf(req: ApiKeyAuthenticatedRequest): string {
    const principal = req.oauthUserId
      ? `oauth:${req.oauthUserId}`
      : req.apiKeyUuid
        ? `key:${req.apiKeyUuid}`
        : "none";
    return `${req.endpoint?.uuid ?? ""}|${principal}`;
  }

  record(sessionId: string, req: ApiKeyAuthenticatedRequest): void {
    this.owners.set(sessionId, SessionOwnerRegistry.ownerOf(req));
  }

  /** Unknown sessions are never owned, so callers fail closed. */
  isOwner(sessionId: string, req: ApiKeyAuthenticatedRequest): boolean {
    const owner = this.owners.get(sessionId);
    return owner !== undefined && owner === SessionOwnerRegistry.ownerOf(req);
  }

  forget(sessionId: string): void {
    this.owners.delete(sessionId);
  }
}
