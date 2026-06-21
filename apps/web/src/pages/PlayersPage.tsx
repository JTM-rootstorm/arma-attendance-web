import { useState } from "react";

import { CommandPanel } from "../components/CommandPanel";
import { MetricTile } from "../components/MetricTile";
import { OperationLifecycleChip, OperationOutcomeChip, StatusChip } from "../components/StatusChip";
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
  onRefresh,
  onSelectPlayer,
  canExport,
  canResetPlayerNames,
  canDeletePlayers,
  onResetPlayerName,
  onDeletePlayer,
  onExportPlayers
}: {
  players: ApiResult<PlayersResponse>;
  playerDetail: ApiResult<PlayerDetailResponse>;
  playerSummary: ApiResult<PlayerSummaryResponse>;
  playerSearch: string;
  selectedPlayerUid: string;
  onSearchChange: (value: string) => void;
  onSearch: () => void;
  onRefresh: () => void;
  onSelectPlayer: (playerUid: string) => void;
  canExport: boolean;
  canResetPlayerNames: boolean;
  canDeletePlayers: boolean;
  onResetPlayerName: (playerUid: string) => Promise<void>;
  onDeletePlayer: (playerUid: string) => Promise<void>;
  onExportPlayers: () => void;
}) {
  const detail = playerDetail.status === "ready" ? playerDetail.data : null;
  const summary = playerSummary.status === "ready" ? playerSummary.data : null;
  const [deletePlayerUid, setDeletePlayerUid] = useState("");
  const [isDeletingPlayer, setIsDeletingPlayer] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const isDetailOpen = selectedPlayerUid.length > 0;
  const canSeeOperationCounts =
    players.status === "ready" && players.data.players.some((player) => player.operation_count !== null);
  const canSeeRecentOperations = Boolean(summary && summary.recent_operations.length > 0);
  const scoreboardTotals = summary?.scoreboard_totals;
  const deletingSelectedPlayer = deletePlayerUid === selectedPlayerUid ? detail?.player : null;
  const deletingPlayerName = displayValue(deletingSelectedPlayer?.last_name);

  async function confirmDeletePlayer() {
    if (!deletePlayerUid || isDeletingPlayer) {
      return;
    }

    setIsDeletingPlayer(true);
    setDeleteError("");

    try {
      await onDeletePlayer(deletePlayerUid);
      setDeletePlayerUid("");
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Player could not be deleted.");
    } finally {
      setIsDeletingPlayer(false);
    }
  }

  return (
    <div className="view-grid">
      <CommandPanel
        title="Player Registry"
        eyebrow="Roster uplink"
        wide
        actions={
          <div className="inline-actions">
            <button type="button" onClick={onRefresh}>
              Refresh
            </button>
            {canExport ? (
              <button type="button" onClick={onExportPlayers}>
                Players CSV
              </button>
            ) : null}
          </div>
        }
      >
        <div className={isDetailOpen ? "drilldown-stage is-open" : "drilldown-stage"}>
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
                    {canSeeOperationCounts ? <th>Ops</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {players.data.players.map((player, index) => {
                    const playerUid = player.player_uid;
                    const canSelectPlayer = playerUid !== null;
                    const rowKey = playerUid ?? `${player.last_name ?? "restricted"}-${player.last_seen_at}-${index}`;

                    return (
                      <tr
                        key={rowKey}
                        className={canSelectPlayer && playerUid === selectedPlayerUid ? "selected" : ""}
                        onClick={playerUid ? () => onSelectPlayer(playerUid) : undefined}
                      >
                        <td className="mono">{playerUid ?? "Restricted"}</td>
                        <td>{displayValue(player.last_name)}</td>
                        <td>{formatDate(player.last_seen_at)}</td>
                        {canSeeOperationCounts ? <td>{player.operation_count ?? "Restricted"}</td> : null}
                      </tr>
                    );
                  })}
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
                <div className="inline-actions">
                  {canResetPlayerNames ? (
                    <button type="button" className="secondary" onClick={() => void onResetPlayerName(selectedPlayerUid)}>
                      Reset name
                    </button>
                  ) : null}
                  {canDeletePlayers ? (
                    <button type="button" className="danger" onClick={() => {
                      setDeleteError("");
                      setDeletePlayerUid(selectedPlayerUid);
                    }}>
                      Delete player
                    </button>
                  ) : null}
                  <button type="button" className="secondary" onClick={() => onSelectPlayer("")}>
                    Return to roster
                  </button>
                </div>
              </div>

              <DataMessage result={playerDetail} />
              <DataMessage result={playerSummary} />
              {detail && summary ? (
                <>
                  <div className="detail-grid">
                    <div>
                      <h3>{displayValue(detail.player.last_name)}</h3>
                      {detail.player.player_uid ? <p className="mono">{detail.player.player_uid}</p> : null}
                      <div className="detail-meta">
                        <StatusChip label={`first ${formatDate(detail.player.first_seen_at)}`} tone="muted" />
                        <StatusChip label={`last ${formatDate(detail.player.last_seen_at)}`} tone="info" />
                      </div>
                    </div>
                    <div className="metric-grid compact">
                      {summary.summary.operation_count !== null ? <MetricTile label="Operations" value={summary.summary.operation_count} /> : null}
                      <MetricTile label="Infantry kills" value={scoreboardTotals?.infantry_kills ?? summary.summary.infantry_kills} />
                      <MetricTile label="Soft armor kills" value={scoreboardTotals?.soft_vehicle_kills ?? summary.summary.soft_vehicle_kills ?? 0} />
                      <MetricTile label="Armor kills" value={scoreboardTotals?.armor_kills ?? summary.summary.armor_kills ?? 0} />
                      <MetricTile label="Plane kills" value={scoreboardTotals?.air_kills ?? summary.summary.air_kills ?? 0} />
                      <MetricTile label="Deaths" value={summary.summary.deaths} />
                    </div>
                  </div>
                  {canSeeRecentOperations ? (
                    <TacticalTable label="Player recent operations" maxVisibleRows={10}>
                      <thead>
                        <tr>
                          <th>Mission</th>
                          <th>Lifecycle</th>
                          <th>Outcome</th>
                          <th>Started</th>
                          <th>Present</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.recent_operations.map((operation) => (
                          <tr key={operation.operation_id}>
                            <td>{displayValue(operation.mission_name)}</td>
                            <td>
                              <OperationLifecycleChip status={operation.status} />
                            </td>
                            <td>
                              <OperationOutcomeChip status={operation.status} />
                            </td>
                            <td>{formatDate(operation.started_at)}</td>
                            <td>{operation.present_at_start || operation.present_at_end ? "yes" : "no"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </TacticalTable>
                  ) : null}
                </>
              ) : null}
            </section>
          ) : null}
        </div>
      </CommandPanel>

      {deletePlayerUid ? (
        <div className="modal-backdrop" role="presentation">
          <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-player-title">
            <p className="panel-eyebrow">Roster deletion</p>
            <h3 id="delete-player-title">Delete Player Link</h3>
            <p>
              Remove <strong>{deletingPlayerName}</strong> from active unit rosters and delete their Discord OAuth link.
              SteamID and past operation records will be retained.
            </p>
            {deletingSelectedPlayer?.player_uid ? <p className="mono confirm-subtext">{deletingSelectedPlayer.player_uid}</p> : null}
            {deleteError ? <p className="message error">{deleteError}</p> : null}
            <div className="inline-actions confirm-actions">
              <button type="button" className="secondary" onClick={() => setDeletePlayerUid("")} disabled={isDeletingPlayer}>
                Cancel
              </button>
              <button type="button" className="danger" onClick={() => void confirmDeletePlayer()} disabled={isDeletingPlayer}>
                {isDeletingPlayer ? "Deleting" : "Delete player"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
