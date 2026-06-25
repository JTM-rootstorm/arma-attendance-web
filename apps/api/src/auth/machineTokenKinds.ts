import type { MachineTokenKind } from "../auth.js";

export const machineTokenKindSets = {
  ingest: ["api", "arma_server"],
  botWriter: ["api", "bot"],
  adminOrBotOrIngest: ["api", "bot", "arma_server"],
  base44: ["base44_integration"],
  userReadable: ["api", "arma_server", "base44_integration"]
} as const satisfies Record<string, readonly MachineTokenKind[]>;
