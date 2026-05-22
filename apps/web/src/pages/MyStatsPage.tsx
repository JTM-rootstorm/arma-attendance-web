import type { FormEvent } from "react";
import { useEffect, useState } from "react";

import { formatDate } from "../format";
import type { ApiResult, AuthUser, MyOperationsResponse, MyPlayerResponse } from "../types";

export function MyStatsPage({
  user,
  myPlayer,
  myOperations,
  onRefresh,
  onUpdatePlayerName,
  onLinkSteam,
  onUnlinkSteam
}: {
  user: AuthUser;
  myPlayer: ApiResult<MyPlayerResponse>;
  myOperations: ApiResult<MyOperationsResponse>;
  onRefresh: () => void;
  onUpdatePlayerName: (displayName: string) => Promise<void>;
  onLinkSteam: () => void;
  onUnlinkSteam: () => void;
}) {
  const steamIdentity = user.identities.find((identity) => identity.provider === "steam");
  const discordIdentity = user.identities.find((identity) => identity.provider === "discord");
  const player = myPlayer.status === "ready" ? myPlayer.data.linked_player : null;
  const battalionMemberships = myPlayer.status === "ready" ? myPlayer.data.battalion_memberships ?? [] : [];
  const primaryBattalion = battalionMemberships[0] ?? null;
  const summary = myPlayer.status === "ready" ? myPlayer.data.summary : null;
  const scoreboardTotals = myPlayer.status === "ready" ? myPlayer.data.scoreboard_totals : null;
  const operations = myOperations.status === "ready" ? myOperations.data.operations.slice(0, 5) : [];
  const [playerName, setPlayerName] = useState(player?.display_name ?? "");
  const [playerNameState, setPlayerNameState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [playerNameError, setPlayerNameError] = useState("");

  useEffect(() => {
    setPlayerName(player?.display_name ?? "");
  }, [player?.display_name]);

  async function submitPlayerName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nextName = playerName.trim();

    if (!nextName) {
      setPlayerNameError("Player name is required.");
      setPlayerNameState("error");
      return;
    }

    setPlayerNameState("saving");
    setPlayerNameError("");

    try {
      await onUpdatePlayerName(nextName);
      setPlayerName(nextName);
      setPlayerNameState("saved");
    } catch (error) {
      setPlayerNameError(error instanceof Error ? error.message : "Player name update failed.");
      setPlayerNameState("error");
    }
  }

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
          <span>Battalion</span>
          <strong>{primaryBattalion?.name ?? "Unassigned"}</strong>
        </div>
        <div>
          <span>Rank</span>
          <strong>{primaryBattalion?.rank ?? player?.rank ?? "Unassigned"}</strong>
        </div>
        <div>
          <span>Ops</span>
          <strong>{summary?.operation_count ?? 0}</strong>
        </div>
        <div>
          <span>Deaths</span>
          <strong>{summary?.deaths ?? 0}</strong>
        </div>
        <div>
          <span>Infantry kills</span>
          <strong>{scoreboardTotals?.infantry_kills ?? summary?.infantry_kills ?? 0}</strong>
        </div>
        <div>
          <span>Soft armor kills</span>
          <strong>{scoreboardTotals?.soft_vehicle_kills ?? summary?.soft_vehicle_kills ?? 0}</strong>
        </div>
        <div>
          <span>Armor kills</span>
          <strong>{scoreboardTotals?.armor_kills ?? summary?.armor_kills ?? 0}</strong>
        </div>
        <div>
          <span>Plane kills</span>
          <strong>{scoreboardTotals?.air_kills ?? summary?.air_kills ?? 0}</strong>
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

      <form className="inline-form player-name-form" onSubmit={(event) => void submitPlayerName(event)}>
        <label>
          <span>Player name</span>
          <input
            value={playerName}
            onChange={(event) => {
              setPlayerName(event.target.value);
              setPlayerNameState("idle");
            }}
            maxLength={200}
            placeholder="Roster display name"
            aria-label="Player name"
          />
        </label>
        <button type="submit" disabled={playerNameState === "saving"}>
          {playerNameState === "saving" ? "Saving" : "Save"}
        </button>
        {playerNameState === "error" ? <p className="message error">{playerNameError}</p> : null}
        {playerNameState === "saved" ? <p className="message">Roster name updated.</p> : null}
      </form>

      {myPlayer.status === "ready" && !myPlayer.data.linked_player ? (
        <p className="empty-copy">{myPlayer.data.message}</p>
      ) : null}

      <section>
        <div className="panel-heading slim">
          <h3>Recent Operations</h3>
        </div>
        <div className="table-wrap">
          <table className="tactical-table static-table">
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
                <tr key={operation.operation_id}>
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
    </section>
  );
}
