import { CommandPanel } from "../components/CommandPanel";
import { MetricTile } from "../components/MetricTile";
import { StatusChip } from "../components/StatusChip";
import { TacticalTable } from "../components/TacticalTable";
import { displayValue, formatDate } from "../format";
import type { ApiResult, PlayerDetailResponse, PlayersResponse, PlayerSummaryResponse } from "../types";

function DataMessage({ result }: { result: ApiResult<unknown> }) {
  if (result.status === "loading") {
    return <p className="message">Loading signal...</p>;
  }

  if (result.status === "error") {
    return <p className="message error">{result.error}</p>;
  }

  return null;
}

export function PlayersPage({
  players,
  playerDetail,
  playerSummary,
  playerSearch,
  selectedPlayerUid,
  onSearchChange,
  onSearch,
  onSelectPlayer,
  onExportPlayers
}: {
  players: ApiResult<PlayersResponse>;
  playerDetail: ApiResult<PlayerDetailResponse>;
  playerSummary: ApiResult<PlayerSummaryResponse>;
  playerSearch: string;
  selectedPlayerUid: string;
  onSearchChange: (value: string) => void;
  onSearch: () => void;
  onSelectPlayer: (playerUid: string) => void;
  onExportPlayers: () => void;
}) {
  const detail = playerDetail.status === "ready" ? playerDetail.data : null;
  const summary = playerSummary.status === "ready" ? playerSummary.data : null;
  const isDetailOpen = selectedPlayerUid.length > 0;

  return (
    <div className="view-grid">
      <CommandPanel title="Player Registry" eyebrow="Roster uplink" wide actions={<button type="button" onClick={onExportPlayers}>Players CSV</button>}>
        <div className="drilldown-stage">
          <div className={isDetailOpen ? "drilldown-base is-obscured" : "drilldown-base"}>
            <form className="filters roster-filter" onSubmit={(event) => event.preventDefault()}>
              <input value={playerSearch} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search players" aria-label="Search players" />
              <button type="button" onClick={onSearch}>
                Search
              </button>
            </form>
            <DataMessage result={players} />
            {players.status === "ready" ? (
              <TacticalTable label="Players">
                <thead>
                  <tr>
                    <th>Player UID</th>
                    <th>Name</th>
                    <th>Last Seen</th>
                    <th>Ops</th>
                  </tr>
                </thead>
                <tbody>
                  {players.data.players.map((player) => (
                    <tr
                      key={player.player_uid}
                      className={player.player_uid === selectedPlayerUid ? "selected" : ""}
                      onClick={() => onSelectPlayer(player.player_uid)}
                    >
                      <td className="mono">{player.player_uid}</td>
                      <td>{displayValue(player.last_name)}</td>
                      <td>{formatDate(player.last_seen_at)}</td>
                      <td>{player.operation_count}</td>
                    </tr>
                  ))}
                </tbody>
              </TacticalTable>
            ) : null}
          </div>

          {isDetailOpen ? (
            <section className="drilldown-overlay" aria-label="Player detail">
              <div className="drilldown-header">
                <div>
                  <p className="panel-eyebrow">Attendance signal</p>
                  <h3>Player Detail</h3>
                </div>
                <button type="button" className="secondary" onClick={() => onSelectPlayer("")}>
                  Return to roster
                </button>
              </div>

              <DataMessage result={playerDetail} />
              <DataMessage result={playerSummary} />
              {detail && summary ? (
                <>
                  <div className="detail-grid">
                    <div>
                      <h3>{displayValue(detail.player.last_name)}</h3>
                      <p className="mono">{detail.player.player_uid}</p>
                      <div className="detail-meta">
                        <StatusChip label={`first ${formatDate(detail.player.first_seen_at)}`} tone="muted" />
                        <StatusChip label={`last ${formatDate(detail.player.last_seen_at)}`} tone="info" />
                      </div>
                    </div>
                    <div className="metric-grid compact">
                      <MetricTile label="Operations" value={summary.summary.operation_count} />
                      <MetricTile label="Start count" value={summary.summary.present_at_start_count} />
                      <MetricTile label="End count" value={summary.summary.present_at_end_count} />
                      <MetricTile label="AI kills" value={summary.summary.ai_kills} />
                      <MetricTile label="Deaths" value={summary.summary.deaths} />
                    </div>
                  </div>
                  <TacticalTable label="Player recent operations" maxVisibleRows={10}>
                    <thead>
                      <tr>
                        <th>Mission</th>
                        <th>Status</th>
                        <th>Started</th>
                        <th>Present</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.recent_operations.map((operation) => (
                        <tr key={operation.operation_id}>
                          <td>{displayValue(operation.mission_name)}</td>
                          <td>{operation.status}</td>
                          <td>{formatDate(operation.started_at)}</td>
                          <td>{operation.present_at_start || operation.present_at_end ? "yes" : "no"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </TacticalTable>
                </>
              ) : null}
            </section>
          ) : null}
        </div>
      </CommandPanel>
    </div>
  );
}
