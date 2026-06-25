import { CommandPanel } from "../components/CommandPanel";
import { MetricTile } from "../components/MetricTile";
import { OperationLifecycleChip, OperationOutcomeChip, OperationStatusPair } from "../components/StatusChip";
import { TacticalTable } from "../components/TacticalTable";
import { displayPlayerName, displayValue, formatDate } from "../format";
import type {
  ApiResult,
  OperationAttendanceResponse,
  OperationDetailResponse,
  OperationListItem,
  OperationsResponse,
  OperationSummaryResponse
} from "../types";

function DataMessage({ result }: { result: ApiResult<unknown> }) {
  if (result.status === "loading") {
    return <p className="message">Loading signal...</p>;
  }

  if (result.status === "error") {
    return <p className="message error">{result.error}</p>;
  }

  return null;
}

function OperationsTable({
  label,
  operations,
  emptyMessage,
  selectedId,
  onSelect
}: {
  label: string;
  operations: OperationListItem[];
  emptyMessage: string;
  selectedId: string;
  onSelect: (operationId: string) => void;
}) {
  return (
    <TacticalTable label={label}>
      <thead>
        <tr>
          <th>Mission</th>
          <th>World</th>
          <th>Server</th>
          <th>Lifecycle</th>
          <th>Outcome</th>
          <th>Started</th>
          <th>Payloads</th>
        </tr>
      </thead>
      <tbody>
        {operations.map((operation) => (
          <tr
            key={operation.id}
            className={operation.id === selectedId ? "selected" : ""}
            onClick={() => onSelect(operation.id)}
          >
            <td>{displayValue(operation.mission_name)}</td>
            <td>{displayValue(operation.world_name)}</td>
            <td className="mono">{operation.server_key}</td>
            <td>
              <OperationLifecycleChip status={operation.status} />
            </td>
            <td>
              <OperationOutcomeChip status={operation.status} />
            </td>
            <td>{formatDate(operation.started_at)}</td>
            <td>{displayValue(operation.payload_count)}</td>
          </tr>
        ))}
        {operations.length === 0 ? (
          <tr>
            <td colSpan={7}>{emptyMessage}</td>
          </tr>
        ) : null}
      </tbody>
    </TacticalTable>
  );
}

function statValue(row: OperationAttendanceResponse["attendance"][number], key: keyof NonNullable<OperationAttendanceResponse["attendance"][number]["scoreboard_stats"]>) {
  return row.scoreboard_stats?.[key] ?? row.stats?.[key as keyof NonNullable<OperationAttendanceResponse["attendance"][number]["stats"]>];
}

function AttendanceTable({ rows }: { rows: OperationAttendanceResponse["attendance"] }) {
  const showPlayerId = rows.some((row) => row.player_uid);

  return (
    <TacticalTable label="Operation attendance" maxVisibleRows={10}>
      <thead>
        <tr>
          {showPlayerId ? <th>Player ID</th> : null}
          <th>Name</th>
          <th>Infantry kills</th>
          <th>Soft armor kills</th>
          <th>Armor kills</th>
          <th>Plane kills</th>
          <th>Deaths</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={row.player_uid ?? `${row.name_at_end ?? row.name_at_start ?? "player"}-${index}`}>
            {showPlayerId ? <td className="mono">{displayValue(row.player_uid)}</td> : null}
            <td>{displayPlayerName(row.name_at_end ?? row.name_at_start)}</td>
            <td>{displayValue(statValue(row, "infantry_kills"))}</td>
            <td>{displayValue(statValue(row, "soft_vehicle_kills"))}</td>
            <td>{displayValue(statValue(row, "armor_kills"))}</td>
            <td>{displayValue(statValue(row, "air_kills"))}</td>
            <td>{displayValue(statValue(row, "deaths"))}</td>
          </tr>
        ))}
      </tbody>
    </TacticalTable>
  );
}

export function OperationsPage({
  operations,
  operationDetail,
  operationSummary,
  operationAttendance,
  selectedOperationId,
  operationFilters,
  onFiltersChange,
  onSelectOperation,
  onRefresh,
  canExport,
  canDeleteOperations,
  onDeleteOperation,
  onExportAttendance
}: {
  operations: ApiResult<OperationsResponse>;
  operationDetail: ApiResult<OperationDetailResponse>;
  operationSummary: ApiResult<OperationSummaryResponse>;
  operationAttendance: ApiResult<OperationAttendanceResponse>;
  selectedOperationId: string;
  operationFilters: { server_key: string; status: string; mission_uid: string };
  onFiltersChange: (filters: { server_key: string; status: string; mission_uid: string }) => void;
  onSelectOperation: (operationId: string) => void;
  onRefresh: () => void;
  canExport: boolean;
  canDeleteOperations: boolean;
  onDeleteOperation: (operationId: string) => Promise<void>;
  onExportAttendance: (operationId: string) => void;
}) {
  const detail = operationDetail.status === "ready" ? operationDetail.data : null;
  const summary = operationSummary.status === "ready" ? operationSummary.data : null;
  const attendance = operationAttendance.status === "ready" ? operationAttendance.data : null;
  const isDetailOpen = selectedOperationId.length > 0;
  const operationRows = operations.status === "ready" ? operations.data.operations : [];
  const inProgressOperations = operationRows.filter((operation) => operation.status === "started");
  const finishedOperations = operationRows.filter((operation) => operation.status !== "started");

  return (
    <div className="view-grid">
      <CommandPanel title="Operations" eyebrow="Mission telemetry" wide actions={<button type="button" onClick={onRefresh}>Refresh</button>}>
        <div className={isDetailOpen ? "drilldown-stage is-open" : "drilldown-stage"}>
          <div className={isDetailOpen ? "drilldown-base is-obscured" : "drilldown-base"}>
            <form className="filters" onSubmit={(event) => event.preventDefault()}>
              <input
                value={operationFilters.server_key}
                onChange={(event) => onFiltersChange({ ...operationFilters, server_key: event.target.value })}
                placeholder="server_key"
                aria-label="Server key filter"
              />
              <select
                value={operationFilters.status}
                onChange={(event) => onFiltersChange({ ...operationFilters, status: event.target.value })}
                aria-label="Status filter"
              >
                <option value="">any lifecycle</option>
                <option value="started">started</option>
                <option value="finished">finished / mission success</option>
                <option value="failed">finished / mission failed</option>
                <option value="abandoned">abandoned</option>
              </select>
              <input
                value={operationFilters.mission_uid}
                onChange={(event) => onFiltersChange({ ...operationFilters, mission_uid: event.target.value })}
                placeholder="mission_uid"
                aria-label="Mission UID filter"
              />
            </form>
            <DataMessage result={operations} />
            {operations.status === "ready" ? (
              <div className="operations-table-stack">
                <section>
                  <div className="panel-heading slim">
                    <h3>In-Progress Operations</h3>
                  </div>
                  <OperationsTable
                    label="In-progress operations"
                    operations={inProgressOperations}
                    emptyMessage="No in-progress operations."
                    selectedId={selectedOperationId}
                    onSelect={onSelectOperation}
                  />
                </section>
                <section>
                  <div className="panel-heading slim">
                    <h3>Finished Operations</h3>
                  </div>
                  <OperationsTable
                    label="Finished operations"
                    operations={finishedOperations}
                    emptyMessage="No finished operations."
                    selectedId={selectedOperationId}
                    onSelect={onSelectOperation}
                  />
                </section>
              </div>
            ) : null}
          </div>

          {isDetailOpen ? (
            <section className="drilldown-overlay" aria-label="Operation detail">
              <div className="drilldown-header">
                <div>
                  <p className="panel-eyebrow">Selected signal</p>
                  <h3>Operation Detail</h3>
                </div>
                <div className="panel-actions">
                  {detail && canExport ? (
                    <button type="button" onClick={() => onExportAttendance(selectedOperationId)}>
                      Attendance CSV
                    </button>
                  ) : null}
                  {detail && canDeleteOperations ? (
                    <button
                      type="button"
                      className="danger"
                      onClick={() => {
                        if (window.confirm("Delete this operation and its attendance data?")) {
                          void onDeleteOperation(selectedOperationId);
                        }
                      }}
                    >
                      Delete
                    </button>
                  ) : null}
                  <button type="button" className="secondary" onClick={() => onSelectOperation("")}>
                    Return to operations table
                  </button>
                </div>
              </div>

              <DataMessage result={operationDetail} />
              <DataMessage result={operationSummary} />
              <DataMessage result={operationAttendance} />
              {detail && summary ? (
                <div className="detail-grid">
                  <div>
                    <h3>{displayValue(detail.operation.mission_name)}</h3>
                    <p className="mono">{detail.operation.id}</p>
                    <div className="detail-meta">
                      <OperationStatusPair status={detail.operation.status} />
                      <span>{displayValue(detail.operation.world_name)}</span>
                      <span>{formatDate(detail.operation.started_at)}</span>
                    </div>
                  </div>
                  <div className="metric-grid compact">
                    <MetricTile label="Payloads" value={summary.payloads.total} detail={`${summary.payloads.start} start / ${summary.payloads.finish} end`} />
                    <MetricTile label="Start present" value={summary.attendance.present_at_start} />
                    <MetricTile label="End present" value={summary.attendance.present_at_end} />
                    <MetricTile label="Both" value={summary.attendance.both_start_and_end} />
                    <MetricTile label="AI kills" value={summary.stats.ai_kills} />
                    <MetricTile label="Deaths" value={summary.stats.deaths} />
                  </div>
                </div>
              ) : null}
              {attendance ? <AttendanceTable rows={attendance.attendance} /> : null}
            </section>
          ) : null}
        </div>
      </CommandPanel>
    </div>
  );
}
