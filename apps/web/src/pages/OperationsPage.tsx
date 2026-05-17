import { CommandPanel } from "../components/CommandPanel";
import { MetricTile } from "../components/MetricTile";
import { OperationStatusChip, StatusChip } from "../components/StatusChip";
import { TacticalTable } from "../components/TacticalTable";
import { displayValue, formatDate } from "../format";
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
  operations,
  selectedId,
  onSelect
}: {
  operations: OperationListItem[];
  selectedId: string;
  onSelect: (operationId: string) => void;
}) {
  return (
    <TacticalTable label="Operations">
      <thead>
        <tr>
          <th>Mission</th>
          <th>World</th>
          <th>Server</th>
          <th>Status</th>
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
              <OperationStatusChip status={operation.status} />
            </td>
            <td>{formatDate(operation.started_at)}</td>
            <td>{displayValue(operation.payload_count)}</td>
          </tr>
        ))}
      </tbody>
    </TacticalTable>
  );
}

function AttendanceTable({ rows }: { rows: OperationAttendanceResponse["attendance"] }) {
  return (
    <TacticalTable label="Operation attendance" maxVisibleRows={10}>
      <thead>
        <tr>
          <th>Player UID</th>
          <th>Name</th>
          <th>Present</th>
          <th>Side</th>
          <th>Group</th>
          <th>Role</th>
          <th>K/D</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.player_uid}>
            <td className="mono">{row.player_uid}</td>
            <td>{displayValue(row.name_at_end ?? row.name_at_start)}</td>
            <td>
              <span className="status-pair">
                <StatusChip label="start" tone={row.present_at_start ? "ready" : "muted"} />
                <StatusChip label="end" tone={row.present_at_end ? "ready" : "muted"} />
              </span>
            </td>
            <td>{displayValue(row.side_at_end ?? row.side_at_start)}</td>
            <td>{displayValue(row.group_at_end ?? row.group_at_start)}</td>
            <td>{displayValue(row.role_at_end ?? row.role_at_start)}</td>
            <td>{row.stats ? `${row.stats.ai_kills + row.stats.infantry_kills + row.stats.vehicle_kills}/${row.stats.deaths}` : "n/a"}</td>
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
  onExportAttendance: (operationId: string) => void;
}) {
  const detail = operationDetail.status === "ready" ? operationDetail.data : null;
  const summary = operationSummary.status === "ready" ? operationSummary.data : null;
  const attendance = operationAttendance.status === "ready" ? operationAttendance.data : null;
  const isDetailOpen = selectedOperationId.length > 0;

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
                <option value="">any status</option>
                <option value="started">started</option>
                <option value="finished">finished</option>
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
              <OperationsTable operations={operations.data.operations} selectedId={selectedOperationId} onSelect={onSelectOperation} />
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
                  {detail ? (
                    <button type="button" onClick={() => onExportAttendance(detail.operation.id)}>
                      Attendance CSV
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
                      <StatusChip label={detail.operation.status} tone={detail.operation.status === "abandoned" ? "danger" : "info"} />
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
