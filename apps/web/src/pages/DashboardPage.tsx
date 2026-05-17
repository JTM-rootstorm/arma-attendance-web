import { CommandPanel } from "../components/CommandPanel";
import { MetricTile } from "../components/MetricTile";
import { OperationStatusChip, StatusChip } from "../components/StatusChip";
import { TacticalTable } from "../components/TacticalTable";
import { displayValue, formatDate } from "../format";
import type { ApiResult, DashboardSummaryResponse, DataQualityResponse, OperationListItem } from "../types";

function DataMessage({ result }: { result: ApiResult<unknown> }) {
  if (result.status === "loading") {
    return <p className="message">Loading signal...</p>;
  }

  if (result.status === "error") {
    return <p className="message error">{result.error}</p>;
  }

  return null;
}

function issueTotal(dataQuality: DataQualityResponse | null): number {
  if (!dataQuality) {
    return 0;
  }

  return Object.values(dataQuality.checks).reduce((total, rows) => total + rows.length, 0);
}

function RecentOperationsTable({
  operations,
  onSelect
}: {
  operations: OperationListItem[];
  onSelect: (operationId: string) => void;
}) {
  return (
    <TacticalTable label="Recent operations">
      <thead>
        <tr>
          <th>Mission</th>
          <th>World</th>
          <th>Server</th>
          <th>Status</th>
          <th>Attendance</th>
          <th>Started</th>
        </tr>
      </thead>
      <tbody>
        {operations.map((operation) => (
          <tr key={operation.id} onClick={() => onSelect(operation.id)}>
            <td>{displayValue(operation.mission_name)}</td>
            <td>{displayValue(operation.world_name)}</td>
            <td className="mono">{operation.server_key}</td>
            <td>
              <OperationStatusChip status={operation.status} />
            </td>
            <td>{displayValue(operation.attendance_count ?? operation.payload_count)}</td>
            <td>{formatDate(operation.started_at)}</td>
          </tr>
        ))}
      </tbody>
    </TacticalTable>
  );
}

export function DashboardPage({
  hasToken,
  summary,
  dataQuality,
  onSelectOperation,
  onOpenOperations,
  onOpenPlayers,
  onExportPlayers
}: {
  hasToken: boolean;
  summary: ApiResult<DashboardSummaryResponse>;
  dataQuality: ApiResult<DataQualityResponse>;
  onSelectOperation: (operationId: string) => void;
  onOpenOperations: () => void;
  onOpenPlayers: () => void;
  onExportPlayers: () => void;
}) {
  const summaryData = summary.status === "ready" ? summary.data : null;
  const dataQualityData = dataQuality.status === "ready" ? dataQuality.data : null;
  const openOperations = summaryData?.recent_operations.filter((operation) => operation.status === "started") ?? [];
  const qualityIssueTotal = issueTotal(dataQualityData);

  return (
    <div className="view-grid">
      {!hasToken ? (
        <CommandPanel title="Token Gate" eyebrow="Secure uplink" wide>
          <p className="message">Enter a bearer token to load internal operation telemetry.</p>
        </CommandPanel>
      ) : null}

      <DataMessage result={summary} />

      <CommandPanel title="Command Overview" eyebrow="Operational registry">
        <div className="metric-grid">
          <MetricTile label="Operations" value={summaryData?.summary.operations_total} detail="all recorded" />
          <MetricTile label="Finished" value={summaryData?.summary.operations_finished} detail="closed signals" />
          <MetricTile label="Started" value={summaryData?.summary.operations_started} detail="active status" />
          <MetricTile label="Players" value={summaryData?.summary.players_total} detail="registry count" />
          <MetricTile label="Attendance" value={summaryData?.summary.attendance_rows_total} detail="normalized rows" />
          <MetricTile label="Last op" value={summaryData ? formatDate(summaryData.summary.last_operation_at) : null} detail="latest contact" />
        </div>
      </CommandPanel>

      <CommandPanel
        title="Attendance Integrity"
        eyebrow="Data quality"
        actions={<StatusChip label={qualityIssueTotal > 0 ? `${qualityIssueTotal} flags` : "clear"} tone={qualityIssueTotal > 0 ? "warn" : "ready"} />}
      >
        <DataMessage result={dataQuality} />
        <div className="integrity-list">
          {dataQualityData
            ? Object.entries(dataQualityData.checks).map(([key, rows]) => (
                <div key={key}>
                  <span>{key.replaceAll("_", " ")}</span>
                  <strong>{rows.length}</strong>
                </div>
              ))
            : null}
        </div>
      </CommandPanel>

      <CommandPanel title="Recent Operations" eyebrow="Mission telemetry" wide actions={<button type="button" onClick={onOpenOperations}>Open Operations</button>}>
        {summaryData ? <RecentOperationsTable operations={summaryData.recent_operations} onSelect={onSelectOperation} /> : null}
      </CommandPanel>

      <CommandPanel title="Active Operations" eyebrow="Started signals" actions={<StatusChip label={`${openOperations.length} active`} tone={openOperations.length > 0 ? "active" : "muted"} pulse={openOperations.length > 0} />}>
        <div className="signal-list">
          {openOperations.length === 0 ? <p className="message">No started operations are currently reporting.</p> : null}
          {openOperations.slice(0, 5).map((operation) => (
            <button key={operation.id} type="button" className="signal-card" onClick={() => onSelectOperation(operation.id)}>
              <strong>{displayValue(operation.mission_name)}</strong>
              <span>{displayValue(operation.world_name)} / {formatDate(operation.started_at)}</span>
            </button>
          ))}
        </div>
      </CommandPanel>

      <CommandPanel title="Player Registry" eyebrow="Roster uplink" actions={<button type="button" onClick={onOpenPlayers}>Open Roster</button>}>
        <TacticalTable label="Top attendance">
          <thead>
            <tr>
              <th>Player</th>
              <th>Ops</th>
            </tr>
          </thead>
          <tbody>
            {summaryData?.top_players_by_attendance.map((player) => (
              <tr key={player.player_uid}>
                <td>{displayValue(player.last_name) !== "n/a" ? displayValue(player.last_name) : player.player_uid}</td>
                <td>{player.operation_count}</td>
              </tr>
            ))}
          </tbody>
        </TacticalTable>
      </CommandPanel>

      <CommandPanel title="Export Console" eyebrow="Payload archive">
        <div className="export-stack">
          <button type="button" onClick={onExportPlayers} disabled={!hasToken}>
            Export Players CSV
          </button>
          <p className="message">Operation attendance CSV is available from a selected operation.</p>
        </div>
      </CommandPanel>
    </div>
  );
}
