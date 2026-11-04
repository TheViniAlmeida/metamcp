import { ApiKeysRepository } from "../../db/repositories/api-keys.repo";

const apiKeysRepository = new ApiKeysRepository();

export async function resolveUserIdFromApiKey(key: string): Promise<string> {
  const validation = await apiKeysRepository.validateApiKey(key);

  if (!validation.valid) {
    throw new Error("Invalid or inactive API key");
  }

  if (validation.endpoint_uuid) {
    throw new Error("Endpoint-scoped API keys cannot use admin tools");
  }

  // A public key belongs to no account; acting as some other user (the
  // first one in the database) would hand that account to whoever holds it.
  if (!validation.user_id) {
    throw new Error("Public API keys cannot use admin tools");
  }

  return validation.user_id;
}
