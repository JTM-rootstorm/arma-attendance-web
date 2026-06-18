import type { FastifyRequest } from "fastify";

import { getAcceptedMachineTokenKind, type MachineTokenKind } from "../auth.js";
import { machineTokenKindSets } from "./machineTokenKinds.js";

export type AuthContextOptions = {
  allowMachineToken?: boolean;
  allowBotToken?: boolean;
  machineTokenKinds?: readonly MachineTokenKind[];
};

export async function resolveMachineTokenKind(
  request: FastifyRequest,
  options: AuthContextOptions = {}
): Promise<MachineTokenKind | null> {
  if (options.machineTokenKinds) {
    return getAcceptedMachineTokenKind(request, options.machineTokenKinds);
  }

  if (options.allowBotToken) {
    return getAcceptedMachineTokenKind(request, machineTokenKindSets.adminOrBotOrIngest);
  }

  if (options.allowMachineToken) {
    return getAcceptedMachineTokenKind(request, machineTokenKindSets.ingest);
  }

  return null;
}
