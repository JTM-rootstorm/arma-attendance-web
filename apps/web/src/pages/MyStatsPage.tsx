import type { FormEvent } from "react";
import { useEffect, useState } from "react";

import { OperationLifecycleChip, OperationOutcomeChip } from "../components/StatusChip";
import { displayPlayerName, formatDate } from "../format";
import type { ApiResult, AuthUser, MyOperationsResponse, MyPlayerResponse } from "../types";

export function MyStatsPage({
  user,
  myPlayer,
  myOperations,
  onRefresh,
  discordRefreshNotice,
  onUpdatePlayerName,
  onUpdateRepresentedUnit,
  onRefreshDiscord,
  onLinkSteam,
  onUnlinkSteam
}: {
  user: AuthUser;
  myPlayer: ApiResult<MyPlayerResponse>;
  myOperations: ApiResult<MyOperationsResponse>;
  onRefresh: () => void;
  discordRefreshNotice: { tone: "success" | "error"; message: string } | null;
  onUpdatePlayerName: (displayName: string) => Promise<void>;
  onUpdateRepresentedUnit: (unitId: string) => Promise<void>;
  onRefreshDiscord: () => Promise<void>;
  onLinkSteam: () => void;
  onUnlinkSteam: () => void;
}) {
  const steamIdentity = user.identities.find((identity) => identity.provider === "steam");
  const discordIdentity = user.identities.find((identity) => identity.provider === "discord");
  const player = myPlayer.status === "ready" ? myPlayer.data.linked_player : null;
  const battalionMemberships = myPlayer.status === "ready" ? myPlayer.data.battalion_memberships ?? [] : [];
  const representedBattalion =
    battalionMemberships.find((membership) => membership.is_represented) ??
    battalionMemberships.find((membership) => membership.unit_id === player?.represented_unit_id) ??
    battalionMemberships[0] ??
    null;
  const summary = myPlayer.status === "ready" ? myPlayer.data.summary : null;
  const scoreboardTotals = myPlayer.status === "ready" ? myPlayer.data.scoreboard_totals : null;
  const operations = myOperations.status === "ready" ? myOperations.data.operations.slice(0, 5) : [];
  const [playerName, setPlayerName] = useState(player?.display_name ?? "");
  const [playerNameDirty, setPlayerNameDirty] = useState(false);
  const [playerNameState, setPlayerNameState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [playerNameError, setPlayerNameError] = useState("");
  const [representedUnitId, setRepresentedUnitId] = useState(representedBattalion?.unit_id ?? "");
  const [representedUnitDirty, setRepresentedUnitDirty] = useState(false);
  const [representedUnitState, setRepresentedUnitState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [representedUnitError, setRepresentedUnitError] = useState("");
  const [discordRefreshState, setDiscordRefreshState] = useState<"idle" | "starting" | "error">("idle");
  const [discordRefreshError, setDiscordRefreshError] = useState("");

  useEffect(() => {
    if (!playerNameDirty) {
      setPlayerName(player?.display_name ?? "");
    }
  }, [player?.display_name, playerNameDirty]);

  useEffect(() => {
    if (!representedUnitDirty) {
      setRepresentedUnitId(representedBattalion?.unit_id ?? "");
    }
  }, [representedBattalion?.unit_id, representedUnitDirty]);

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
      setPlayerNameDirty(false);
      setPlayerNameState("saved");
    } catch (error) {
      setPlayerNameError(error instanceof Error ? error.message : "Player name update failed.");
      setPlayerNameState("error");
    }
  }

  async function submitRepresentedUnit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!representedUnitId) {
      setRepresentedUnitError("Select a battalion to represent.");
      setRepresentedUnitState("error");
      return;
    }

    setRepresentedUnitState("saving");
    setRepresentedUnitError("");

    try {
      await onUpdateRepresentedUnit(representedUnitId);
      setRepresentedUnitDirty(false);
      setRepresentedUnitState("saved");
    } catch (error) {
      setRepresentedUnitError(error instanceof Error ? error.message : "Battalion selection failed.");
      setRepresentedUnitState("error");
    }
  }

  async function submitDiscordRefresh() {
    setDiscordRefreshState("starting");
    setDiscordRefreshError("");

    try {
      await onRefreshDiscord();
    } catch (error) {
      setDiscordRefreshError(error instanceof Error ? error.message : "Discord refresh failed to start.");
      setDiscordRefreshState("error");
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
          <strong>{player?.display_name ? displayPlayerName(player.display_name) : user.display_name ? displayPlayerName(user.display_name) : "Unlinked"}</strong>
        </div>
        <div>
          <span>Battalion</span>
          <strong>{representedBattalion?.name ?? "Unassigned"}</strong>
        </div>
        <div>
          <span>Rank</span>
          <strong>{representedBattalion?.rank ?? player?.rank ?? "Unassigned"}</strong>
        </div>
        <div>
          <span>XP</span>
          <strong>{summary?.xp_total ?? player?.xp_total ?? 0}</strong>
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
          <button type="button" onClick={() => void submitDiscordRefresh()} disabled={!discordIdentity || discordRefreshState === "starting"}>
            {discordRefreshState === "starting" ? "Opening Discord" : "Refresh Discord"}
          </button>
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
      {discordRefreshNotice ? (
        <p className={discordRefreshNotice.tone === "error" ? "message error" : "message"}>{discordRefreshNotice.message}</p>
      ) : null}
      {discordRefreshState === "error" ? <p className="message error">{discordRefreshError}</p> : null}

      <form className="inline-form player-name-form" onSubmit={(event) => void submitPlayerName(event)}>
        <label>
          <span>Player name</span>
          <input
            value={playerName}
            onChange={(event) => {
              setPlayerName(event.target.value);
              setPlayerNameDirty(true);
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

      <form className="inline-form player-name-form" onSubmit={(event) => void submitRepresentedUnit(event)}>
        <label>
          <span>Representing</span>
          <select
            value={representedUnitId}
            onChange={(event) => {
              setRepresentedUnitId(event.target.value);
              setRepresentedUnitDirty(true);
              setRepresentedUnitState("idle");
            }}
            aria-label="Represented battalion"
            disabled={battalionMemberships.length === 0}
          >
            {battalionMemberships.length === 0 ? <option value="">No active battalion memberships</option> : null}
            {battalionMemberships.map((membership) => (
              <option key={membership.unit_id} value={membership.unit_id}>
                {membership.callsign ? `${membership.name} ${membership.callsign}` : membership.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={representedUnitState === "saving" || battalionMemberships.length === 0 || !representedUnitDirty}>
          {representedUnitState === "saving" ? "Saving" : "Save"}
        </button>
        {representedUnitState === "error" ? <p className="message error">{representedUnitError}</p> : null}
        {representedUnitState === "saved" ? <p className="message">Represented battalion updated.</p> : null}
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
                <th>Lifecycle</th>
                <th>Outcome</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {operations.map((operation) => (
                <tr key={operation.operation_id}>
                  <td>{operation.mission_name ?? "Unknown"}</td>
                  <td>{operation.world_name ?? "Unknown"}</td>
                  <td>
                    <OperationLifecycleChip status={operation.status} />
                  </td>
                  <td>
                    <OperationOutcomeChip status={operation.status} />
                  </td>
                  <td>{formatDate(operation.started_at)}</td>
                </tr>
              ))}
              {operations.length === 0 ? (
                <tr>
                  <td colSpan={5}>No linked operations yet.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}
