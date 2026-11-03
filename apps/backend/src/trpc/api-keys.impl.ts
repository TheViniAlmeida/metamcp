import {
  CreateApiKeyRequestSchema,
  CreateApiKeyResponseSchema,
  DeleteApiKeyRequestSchema,
  DeleteApiKeyResponseSchema,
  ListApiKeysResponseSchema,
  UpdateApiKeyRequestSchema,
  UpdateApiKeyResponseSchema,
  ValidateApiKeyRequestSchema,
  ValidateApiKeyResponseSchema,
} from "@repo/zod-types";
import { z } from "zod";

import logger from "@/utils/logger";

import { ApiKeysRepository, endpointsRepository } from "../db/repositories";
import { ApiKeysSerializer } from "../db/serializers";

const apiKeysRepository = new ApiKeysRepository();

export const apiKeysImplementations = {
  create: async (
    input: z.infer<typeof CreateApiKeyRequestSchema>,
    userId: string,
  ): Promise<z.infer<typeof CreateApiKeyResponseSchema>> => {
    try {
      // Use input.user_id if provided, otherwise default to current user (private)
      const apiKeyUserId = input.user_id !== undefined ? input.user_id : userId;

      // A scoped key must point at an endpoint with the same owner as the key
      // (both public, or both owned by the current user).
      if (input.endpoint_uuid) {
        const endpoint = await endpointsRepository.findByUuid(
          input.endpoint_uuid,
        );
        if (!endpoint || endpoint.user_id !== apiKeyUserId) {
          throw new Error("Endpoint not found or not owned by the key owner");
        }
      }

      const result = await apiKeysRepository.create({
        name: input.name,
        user_id: apiKeyUserId,
        endpoint_uuid: input.endpoint_uuid ?? null,
        is_active: true,
      });

      return ApiKeysSerializer.serializeCreateApiKeyResponse(result);
    } catch (error) {
      logger.error("Error creating API key:", error);
      throw new Error(
        error instanceof Error ? error.message : "Internal server error",
      );
    }
  },

  list: async (
    userId: string,
  ): Promise<z.infer<typeof ListApiKeysResponseSchema>> => {
    try {
      const apiKeys = await apiKeysRepository.findAccessibleToUser(userId);

      return {
        apiKeys: ApiKeysSerializer.serializeApiKeyList(apiKeys),
      };
    } catch (error) {
      logger.error("Error fetching API keys:", error);
      throw new Error("Failed to fetch API keys");
    }
  },

  update: async (
    input: z.infer<typeof UpdateApiKeyRequestSchema>,
    userId: string,
  ): Promise<z.infer<typeof UpdateApiKeyResponseSchema>> => {
    try {
      const result = await apiKeysRepository.update(input.uuid, userId, {
        name: input.name,
        is_active: input.is_active,
      });

      return ApiKeysSerializer.serializeApiKey(result);
    } catch (error) {
      logger.error("Error updating API key:", error);
      throw new Error(
        error instanceof Error ? error.message : "Internal server error",
      );
    }
  },

  delete: async (
    input: z.infer<typeof DeleteApiKeyRequestSchema>,
    userId: string,
  ): Promise<z.infer<typeof DeleteApiKeyResponseSchema>> => {
    try {
      await apiKeysRepository.delete(input.uuid, userId);

      return {
        success: true,
        message: "API key deleted successfully",
      };
    } catch (error) {
      logger.error("Error deleting API key:", error);
      return {
        success: false,
        message:
          error instanceof Error ? error.message : "Internal server error",
      };
    }
  },

  validate: async (
    input: z.infer<typeof ValidateApiKeyRequestSchema>,
  ): Promise<z.infer<typeof ValidateApiKeyResponseSchema>> => {
    try {
      const result = await apiKeysRepository.validateApiKey(input.key);
      return {
        valid: result.valid,
        user_id: result.user_id ?? undefined,
        key_uuid: result.key_uuid,
        endpoint_uuid: result.endpoint_uuid ?? null,
      };
    } catch (error) {
      logger.error("Error validating API key:", error);
      return { valid: false };
    }
  },
};
