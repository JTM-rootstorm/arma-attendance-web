import { z } from "zod";

const trimmedString = (maxLength: number) => z.string().trim().min(1).max(maxLength);
const optionalTrimmedString = (maxLength: number) => z.string().trim().max(maxLength).optional();
const optionalPayloadVersion = z.coerce.number().int().positive().optional();

export const missionSchema = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.object({
    mission_uid: optionalTrimmedString(200),
    mission_name: optionalTrimmedString(300),
    world_name: optionalTrimmedString(200)
  })
  .passthrough()
  .optional()
);

export const operationStartBodySchema = z
  .object({
    request_id: trimmedString(200),
    server_key: trimmedString(128),
    payload_version: optionalPayloadVersion,
    mission: missionSchema
  })
  .passthrough();

export const operationFinishBodySchema = z
  .object({
    request_id: trimmedString(200),
    server_key: trimmedString(128),
    payload_version: optionalPayloadVersion,
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
