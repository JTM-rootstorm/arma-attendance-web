import { formatDate } from "../format";
import type { ApiResult, AuthUser, MyOperationMatesResponse, MyOperationsResponse, MyPlayerResponse } from "../types";

export function MyStatsPage({
  user,
  myPlayer,
  myOperations,
  mates,
  selectedOperationId,
  onSelectOperation,
  onRefresh,
  onLinkSteam,
  onUnlinkSteam
}: {
  user: AuthUser;
  myPlayer: ApiResult<MyPlayerResponse>;
  myOperations: ApiResult<MyOperationsResponse>;
  mates: ApiResult<MyOperationMatesResponse>;
  selectedOperationId: string;
  onSelectOperation: (operationId: string) => void;
  onRefresh: () => void;
  onLinkSteam: () => void;
  onUnlinkSteam: () => void;
}) {
  const steamIdentity = user.identities.find((identity) => identity.provider === "steam");
  const discordIdentity = user.identities.find((identity) => identity.provider === "discord");
  const player = myPlayer.status === "ready" ? myPlayer.data.linked_player : null;
  const summary = myPlayer.status === "ready" ? myPlayer.data.summary : null;
  const operations = myOperations.status === "ready" ? myOperations.data.operations : [];

  return (
    <section className="command-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">ME</p>
          <h2>My Stats</h2>
        </div>
        <button type="button" onClick={onRefresh}>
          Refresh
        </button>
      </div>

      <div className="stat-grid compact">
        <div>
          <span>Player</span>
          <strong>{player?.display_name ?? user.display_name ?? "Unlinked"}</strong>
        </div>
        <div>
          <span>Rank</span>
          <strong>{player?.rank ?? "Unassigned"}</strong>
        </div>
        <div>
          <span>Ops</span>
          <strong>{summary?.operation_count ?? 0}</strong>
        </div>
        <div>
          <span>Deaths</span>
          <strong>{summary?.deaths ?? 0}</strong>
        </div>
      </div>

      <div className="identity-strip">
        <div>
          <span>Discord</span>
          <strong>{discordIdentity?.display_name ?? discordIdentity?.provider_user_id ?? "Linked session"}</strong>
        </div>
        <div>
          <span>Steam</span>
          <strong>{steamIdentity ? "Linked" : "Not linked"}</strong>
        </div>
        <div className="inline-actions">
          <button type="button" onClick={onLinkSteam}>
            Link Steam
          </button>
          {steamIdentity ? (
            <button type="button" onClick={onUnlinkSteam}>
              Unlink Steam
            </button>
          ) : null}
        </div>
      </div>

      {myPlayer.status === "ready" && !myPlayer.data.linked_player ? (
        <p className="empty-copy">{myPlayer.data.message}</p>
      ) : null}

      <div className="split-grid">
        <section>
          <div className="panel-heading slim">
            <h3>Recent Operations</h3>
          </div>
          <div className="table-wrap">
            <table className="tactical-table">
              <thead>
                <tr>
                  <th>Mission</th>
                  <th>World</th>
                  <th>Status</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {operations.map((operation) => (
                  <tr
                    key={operation.operation_id}
                    className={operation.operation_id === selectedOperationId ? "selected" : ""}
                    onClick={() => onSelectOperation(operation.operation_id)}
                  >
                    <td>{operation.mission_name ?? "Unknown"}</td>
                    <td>{operation.world_name ?? "Unknown"}</td>
                    <td>{operation.status}</td>
                    <td>{formatDate(operation.started_at)}</td>
                  </tr>
                ))}
                {operations.length === 0 ? (
                  <tr>
                    <td colSpan={4}>No linked operations yet.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <div className="panel-heading slim">
            <h3>Played With</h3>
          </div>
          <div className="stack-list">
            {mates.status === "ready" && mates.data.mates.length > 0
              ? mates.data.mates.map((mate, index) => (
                  <div key={`${mate.name ?? "mate"}-${index}`} className="stack-row">
                    <strong>{mate.name ?? "Unknown"}</strong>
                    <span>{[mate.rank, mate.role, mate.group_name].filter(Boolean).join(" / ") || "No assignment"}</span>
                  </div>
                ))
              : null}
            {mates.status !== "ready" || mates.data.mates.length === 0 ? <p className="empty-copy">Select a recent operation.</p> : null}
          </div>
        </section>
      </div>
    </section>
  );
}
