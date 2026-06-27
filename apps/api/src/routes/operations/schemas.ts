import { z } from "zod";

export const missionSchema = z
  .object({
    mission_uid: z.string().max(200).optional(),
    mission_name: z.string().max(300).optional(),
    world_name: z.string().max(200).optional()
  })
  .passthrough()
  .optional();

export const operationStartBodySchema = z
  .object({
    request_id: z.string().min(1).max(200),
    server_key: z.string().min(1).max(128),
    payload_version: z.number().int().positive().optional(),
    mission: missionSchema
  })
  .passthrough();

export const operationFinishBodySchema = z
  .object({
    request_id: z.string().min(1).max(200),
    server_key: z.string().min(1).max(128),
    payload_version: z.number().int().positive().optional(),
    outcome: z.enum(["success", "failed"]).default("success"),
    mission: missionSchema
  })
  .passthrough();

export const operationParamsSchema = z.object({
  operation_id: z.string().uuid()
});

export const operationListQuerySchema = z.object({
  server_key: z.string().max(128).optional(),
  status: z.enum(["started", "finished", "failed", "abandoned"]).optional(),
  status_group: z.enum(["active", "finished"]).optional(),
  mission_uid: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

export type OperationStartBody = z.infer<typeof operationStartBodySchema>;
export type OperationFinishBody = z.infer<typeof operationFinishBodySchema>;
export type OperationListQuery = z.infer<typeof operationListQuerySchema>;

export function getMissionField(
  mission: z.infer<typeof missionSchema>,
  key: "mission_uid" | "mission_name" | "world_name"
): string | null {
  return mission?.[key] ?? null;
}
