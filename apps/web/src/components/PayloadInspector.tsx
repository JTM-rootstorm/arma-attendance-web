import { displayValue } from "../format";
import type { OperationDetailResponse, PlayerDetailResponse } from "../types";
import { CommandPanel } from "./CommandPanel";
import { StatusChip } from "./StatusChip";

function jsonPreview(value: unknown): string {
  if (value === null || value === undefined) {
    return "No payload recorded.";
  }

  return JSON.stringify(value, null, 2);
}

export function PayloadInspector({
  operationDetail,
  playerDetail,
  exportMessage
}: {
  operationDetail: OperationDetailResponse | null;
  playerDetail: PlayerDetailResponse | null;
  exportMessage: string;
}) {
  return (
    <CommandPanel title="Inspection" eyebrow="Signal detail">
      <div className="inspection-stack">
        {operationDetail ? (
          <section>
            <div className="inspection-title">
              <strong>{displayValue(operationDetail.operation.mission_name)}</strong>
              <StatusChip label={operationDetail.operation.status} tone={operationDetail.operation.status === "abandoned" ? "danger" : "info"} />
            </div>
            <p className="mono">{operationDetail.operation.id}</p>
            <details>
              <summary>Start payload</summary>
              <pre>{jsonPreview(operationDetail.operation.raw_start_payload)}</pre>
            </details>
            <details>
              <summary>End payload</summary>
              <pre>{jsonPreview(operationDetail.operation.raw_end_payload)}</pre>
            </details>
          </section>
        ) : (
          <p className="message">Select an operation or player to inspect the latest signal.</p>
        )}

        {playerDetail ? (
          <section>
            <div className="inspection-title">
              <strong>{displayValue(playerDetail.player.last_name)}</strong>
              <StatusChip label={`${playerDetail.recent_operations.length} recent`} tone="ready" />
            </div>
            <p className="mono">{playerDetail.player.player_uid}</p>
          </section>
        ) : null}

        {exportMessage ? <p className="message">{exportMessage}</p> : null}
      </div>
    </CommandPanel>
  );
}
