import { useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch } from "../api";
import { canSeeSensitiveIds, isOwner, isTcwAdmin } from "../authz";
import { CommandPanel } from "../components/CommandPanel";
import { MetricTile } from "../components/MetricTile";
import { StatusChip } from "../components/StatusChip";
import { TacticalTable } from "../components/TacticalTable";
import { displayValue, formatDate } from "../format";
import type {
  ApiResult,
  AuthUser,
  BattalionPlayerCandidatesResponse,
  BattalionRosterPlayer,
  BattalionRosterResponse,
  BattalionSquadNode,
  BattalionSummary,
  UnitsResponse
} from "../types";

type AssignmentDraft = Record<
  string,
  {
    squad_id: string;
    billet: BattalionRosterPlayer["billet"];
    sort_order: number;
  }
>;

const emptyUnits: ApiResult<UnitsResponse> = { status: "idle", data: null, error: null };
const emptyRoster: ApiResult<BattalionRosterResponse> = { status: "idle", data: null, error: null };
const emptyCandidates: ApiResult<BattalionPlayerCandidatesResponse> = { status: "idle", data: null, error: null };

function errorResult<T>(error: unknown, fallback: string): ApiResult<T> {
  return {
    status: "error",
    data: null,
    error: error instanceof Error ? error.message : fallback
  };
}

function DataMessage({ result }: { result: ApiResult<unknown> }) {
  if (result.status === "loading") {
    return <p className="message">Loading signal...</p>;
  }

  if (result.status === "error") {
    return <p className="message error">{result.error}</p>;
  }

  return null;
}

function flattenSquads(squads: BattalionSquadNode[]): BattalionSquadNode[] {
  return squads.flatMap((squad) => [squad, ...flattenSquads(squad.children)]);
}

function flattenPlayers(roster: BattalionRosterResponse | null): BattalionRosterPlayer[] {
  if (!roster) {
    return [];
  }

  const squadPlayers = flattenSquads(roster.squads).flatMap((squad) => [
    ...(squad.leader ? [squad.leader] : []),
    ...squad.members
  ]);
  const players = [...roster.unassigned, ...squadPlayers];
  const seen = new Set<string>();

  return players.filter((player) => {
    const key = player.player_uid ?? player.roster_name;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function squadLabel(squad: BattalionSquadNode): string {
  return `${squad.name} (${squad.squad_type})`;
}

function slugifyUnitKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function canManageBattalion(user: AuthUser, unit: BattalionSummary | null): boolean {
  if (isOwner(user) || isTcwAdmin(user)) {
    return true;
  }

  return Boolean(unit?.my_roles.some((role) => role === "admin" || role === "tcw_admin"));
}

export function BattalionPage({ user }: { user: AuthUser }) {
  const [units, setUnits] = useState<ApiResult<UnitsResponse>>(emptyUnits);
  const [roster, setRoster] = useState<ApiResult<BattalionRosterResponse>>(emptyRoster);
  const [playerCandidates, setPlayerCandidates] = useState<ApiResult<BattalionPlayerCandidatesResponse>>(emptyCandidates);
  const [selectedUnitId, setSelectedUnitId] = useState("");
  const [candidateSearch, setCandidateSearch] = useState("");
  const [assignmentDraft, setAssignmentDraft] = useState<AssignmentDraft>({});
  const [message, setMessage] = useState("");
  const [newUnit, setNewUnit] = useState({ unit_key: "", name: "", callsign: "" });
  const [newPlayer, setNewPlayer] = useState({ player_uid: "", roster_name: "", rank: "" });
  const [newRank, setNewRank] = useState({ rank_key: "", name: "", short_name: "", sort_order: "0" });
  const [newSquad, setNewSquad] = useState({ squad_key: "", name: "", parent_squad_id: "", squad_type: "squad", hierarchy_mode: "flat" });
  const [adminGrant, setAdminGrant] = useState({ user_id: "", role: "admin" });

  const unitList = units.status === "ready" ? units.data.units : [];
  const selectedUnit = unitList.find((unit) => unit.unit_id === selectedUnitId) ?? unitList[0] ?? null;
  const rosterData = roster.status === "ready" ? roster.data : null;
  const allSquads = useMemo(() => flattenSquads(rosterData?.squads ?? []), [rosterData]);
  const rosterPlayers = useMemo(() => flattenPlayers(rosterData), [rosterData]);
  const canManage = canManageBattalion(user, selectedUnit);
  const canRevealIds = canSeeSensitiveIds(user) || canManage;

  const loadUnits = useCallback(async () => {
    setUnits({ status: "loading", data: null, error: null });

    try {
      const data = await apiFetch<UnitsResponse>("/v1/units", { params: { include_inactive: isOwner(user) ? "true" : undefined } });
      setUnits({ status: "ready", data, error: null });
      setSelectedUnitId((current) => current || data.units[0]?.unit_id || "");
    } catch (error) {
      setUnits(errorResult(error, "Battalions failed."));
    }
  }, [user]);

  const loadRoster = useCallback(async (unitId: string) => {
    if (!unitId) {
      setRoster(emptyRoster);
      return;
    }

    setRoster({ status: "loading", data: null, error: null });

    try {
      setRoster({ status: "ready", data: await apiFetch<BattalionRosterResponse>(`/v1/units/${unitId}/roster`), error: null });
    } catch (error) {
      setRoster(errorResult(error, "Battalion roster failed."));
    }
  }, []);

  const loadPlayerCandidates = useCallback(async (unitId: string, search: string) => {
    if (!unitId || !canManage) {
      setPlayerCandidates(emptyCandidates);
      return;
    }

    setPlayerCandidates({ status: "loading", data: null, error: null });

    try {
      setPlayerCandidates({
        status: "ready",
        data: await apiFetch<BattalionPlayerCandidatesResponse>(`/v1/units/${unitId}/player-candidates`, {
          params: { q: search, limit: "25" }
        }),
        error: null
      });
    } catch (error) {
      setPlayerCandidates(errorResult(error, "Player candidates failed."));
    }
  }, [canManage]);

  useEffect(() => {
    void loadUnits();
  }, [loadUnits]);

  useEffect(() => {
    void loadRoster(selectedUnitId);
  }, [loadRoster, selectedUnitId]);

  useEffect(() => {
    void loadPlayerCandidates(selectedUnitId, candidateSearch);
  }, [candidateSearch, loadPlayerCandidates, selectedUnitId]);

  useEffect(() => {
    const nextDraft: AssignmentDraft = {};

    for (const player of rosterPlayers) {
      if (!player.player_uid) {
        continue;
      }

      nextDraft[player.player_uid] = {
        squad_id: player.squad_id ?? "",
        billet: player.billet,
        sort_order: player.sort_order
      };
    }

    setAssignmentDraft(nextDraft);
  }, [rosterPlayers]);

  async function createUnit() {
    const unitKey = slugifyUnitKey(newUnit.unit_key || newUnit.name);
    const unitName = newUnit.name.trim();

    if (!unitKey || !unitName) {
      setMessage("Battalion key and name are required.");
      return;
    }

    try {
      const created = await apiFetch<{ ok: true; unit: { id: string } }>("/v1/units", {
        method: "POST",
        body: {
          unit_key: unitKey,
          name: unitName,
          display_name: unitName,
          callsign: newUnit.callsign.trim() || null
        }
      });
      setNewUnit({ unit_key: "", name: "", callsign: "" });
      setSelectedUnitId(created.unit.id);
      setMessage("Battalion created.");
      await loadUnits();
      await loadRoster(created.unit.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Battalion could not be created.");
    }
  }

  async function deleteUnit() {
    if (!selectedUnit) {
      return;
    }

    await apiFetch(`/v1/units/${selectedUnit.unit_id}`, { method: "DELETE" });
    setSelectedUnitId("");
    setMessage("Battalion deactivated.");
    await loadUnits();
  }

  async function addPlayer() {
    if (!selectedUnit) {
      return;
    }

    await apiFetch(`/v1/units/${selectedUnit.unit_id}/players`, {
      method: "POST",
      body: {
        player_uid: newPlayer.player_uid,
        roster_name: newPlayer.roster_name || null,
        rank: newPlayer.rank || null
      }
    });
    setNewPlayer({ player_uid: "", roster_name: "", rank: "" });
    setMessage("Roster player added.");
    await loadRoster(selectedUnit.unit_id);
    await loadPlayerCandidates(selectedUnit.unit_id, candidateSearch);
  }

  async function addCandidatePlayer(playerUid: string, rosterName: string | null) {
    if (!selectedUnit) {
      return;
    }

    await apiFetch(`/v1/units/${selectedUnit.unit_id}/players`, {
      method: "POST",
      body: {
        player_uid: playerUid,
        roster_name: rosterName || playerUid,
        roster_status: "active"
      }
    });
    setMessage("Roster player added.");
    await loadRoster(selectedUnit.unit_id);
    await loadPlayerCandidates(selectedUnit.unit_id, candidateSearch);
  }

  async function removePlayer(playerUid: string) {
    if (!selectedUnit) {
      return;
    }

    await apiFetch(`/v1/units/${selectedUnit.unit_id}/players/${encodeURIComponent(playerUid)}`, { method: "DELETE" });
    setMessage("Roster player removed.");
    await loadRoster(selectedUnit.unit_id);
    await loadPlayerCandidates(selectedUnit.unit_id, candidateSearch);
  }

  async function updatePlayerRank(playerUid: string, rankId: string) {
    if (!selectedUnit) {
      return;
    }

    await apiFetch(`/v1/units/${selectedUnit.unit_id}/players/${encodeURIComponent(playerUid)}`, {
      method: "PATCH",
      body: {
        rank: null,
        rank_id: rankId || null
      }
    });
    setMessage("Roster rank updated.");
    await loadRoster(selectedUnit.unit_id);
  }

  async function createRank() {
    if (!selectedUnit) {
      return;
    }

    await apiFetch(`/v1/units/${selectedUnit.unit_id}/ranks`, {
      method: "POST",
      body: {
        rank_key: newRank.rank_key,
        name: newRank.name,
        short_name: newRank.short_name || null,
        sort_order: Number(newRank.sort_order || "0")
      }
    });
    setNewRank({ rank_key: "", name: "", short_name: "", sort_order: "0" });
    setMessage("Rank created.");
    await loadRoster(selectedUnit.unit_id);
  }

  async function createSquad() {
    if (!selectedUnit) {
      return;
    }

    await apiFetch(`/v1/units/${selectedUnit.unit_id}/squads`, {
      method: "POST",
      body: {
        squad_key: newSquad.squad_key,
        name: newSquad.name,
        parent_squad_id: newSquad.parent_squad_id || null,
        squad_type: newSquad.squad_type,
        hierarchy_mode: newSquad.hierarchy_mode
      }
    });
    setNewSquad({ squad_key: "", name: "", parent_squad_id: "", squad_type: "squad", hierarchy_mode: "flat" });
    setMessage("Squad node created.");
    await loadRoster(selectedUnit.unit_id);
    await loadUnits();
  }

  async function deleteSquad(squad: BattalionSquadNode) {
    if (!selectedUnit) {
      return;
    }

    if (!window.confirm(`Delete ${squad.name} and unassign its players? Child squads will also be removed.`)) {
      return;
    }

    await apiFetch(`/v1/units/${selectedUnit.unit_id}/squads/${squad.id}`, { method: "DELETE" });
    setMessage("Squad node deleted.");
    await loadRoster(selectedUnit.unit_id);
    await loadUnits();
  }

  async function saveLayout() {
    if (!selectedUnit) {
      return;
    }

    await apiFetch(`/v1/units/${selectedUnit.unit_id}/squad-layout`, {
      method: "PATCH",
      body: {
        squads: allSquads.map((squad, index) => ({
          id: squad.id,
          parent_squad_id: squad.parent_squad_id,
          sort_order: (index + 1) * 10
        })),
        assignments: Object.entries(assignmentDraft).map(([player_uid, assignment]) => ({
          player_uid,
          squad_id: assignment.squad_id || null,
          billet: assignment.squad_id ? assignment.billet : "unassigned",
          sort_order: assignment.sort_order
        }))
      }
    });
    setMessage("Squad layout saved.");
    await loadRoster(selectedUnit.unit_id);
  }

  async function grantUnitAdmin() {
    if (!selectedUnit) {
      return;
    }

    await apiFetch(`/v1/units/${selectedUnit.unit_id}/admins/${adminGrant.user_id}`, {
      method: "PUT",
      body: { role: adminGrant.role }
    });
    setAdminGrant({ user_id: "", role: "admin" });
    setMessage("Battalion role granted.");
  }

  return (
    <div className="view-grid battalion-view">
      <CommandPanel
        title="Battalion Command"
        eyebrow="Holo-board"
        wide
        actions={
          <div className="inline-actions">
            <button type="button" onClick={() => void loadUnits()}>
              Refresh
            </button>
            {selectedUnit ? (
              <select value={selectedUnit.unit_id} onChange={(event) => setSelectedUnitId(event.target.value)} aria-label="Battalion selector">
                {unitList.map((unit) => (
                  <option key={unit.unit_id} value={unit.unit_id}>
                    {unit.display_name}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        }
      >
        <DataMessage result={units} />
        {selectedUnit ? (
          <>
            <div className="metric-grid compact">
              <MetricTile label="Battalion" value={selectedUnit.display_name} detail={selectedUnit.callsign ?? "No callsign"} />
              <MetricTile label="Troopers" value={selectedUnit.member_count} detail="active roster" />
              <MetricTile label="Unassigned" value={selectedUnit.unassigned_count} detail="intake bay" />
              <MetricTile label="Squads" value={selectedUnit.squad_count} detail="active nodes" />
            </div>
            {message ? <p className="message">{message}</p> : null}
          </>
        ) : (
          <p className="empty-copy">No battalion assignment yet.</p>
        )}
      </CommandPanel>

      <CommandPanel title="Roster Deck" eyebrow="Personnel">
        <DataMessage result={roster} />
        {rosterData ? (
          <>
            <TacticalTable label="Battalion roster" maxVisibleRows={10}>
              <thead>
                <tr>
                  <th>Trooper</th>
                  <th>Rank</th>
                  <th>Status</th>
                  <th>Squad</th>
                  <th>Billet</th>
                  {canManage ? <th>Manage</th> : null}
                </tr>
              </thead>
              <tbody>
                {rosterPlayers.map((player) => {
                  const playerUid = player.player_uid ?? "";
                  const draft = assignmentDraft[playerUid] ?? { squad_id: player.squad_id ?? "", billet: player.billet, sort_order: player.sort_order };

                  return (
                    <tr key={playerUid || player.roster_name}>
                      <td>
                        <strong>{player.roster_name}</strong>
                        {canRevealIds && playerUid ? <p className="mono">{playerUid}</p> : null}
                      </td>
                      <td>
                        {canManage && playerUid ? (
                          <select
                            value={player.rank_id ?? ""}
                            onChange={(event) => void updatePlayerRank(playerUid, event.target.value)}
                            aria-label={`Rank for ${player.roster_name}`}
                          >
                            <option value="">Unassigned</option>
                            {rosterData.ranks.map((rank) => (
                              <option key={rank.id} value={rank.id}>
                                {rank.short_name ?? rank.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          displayValue(player.rank)
                        )}
                      </td>
                      <td>{player.roster_status}</td>
                      <td>
                        {canManage && playerUid ? (
                          <select
                            value={draft.squad_id}
                            onChange={(event) =>
                              setAssignmentDraft((current) => ({
                                ...current,
                                [playerUid]: { ...draft, squad_id: event.target.value }
                              }))
                            }
                          >
                            <option value="">Unassigned</option>
                            {allSquads.map((squad) => (
                              <option key={squad.id} value={squad.id}>
                                {squadLabel(squad)}
                              </option>
                            ))}
                          </select>
                        ) : (
                          allSquads.find((squad) => squad.id === player.squad_id)?.name ?? "Unassigned"
                        )}
                      </td>
                      <td>
                        {canManage && playerUid ? (
                          <select
                            value={draft.billet}
                            onChange={(event) =>
                              setAssignmentDraft((current) => ({
                                ...current,
                                [playerUid]: { ...draft, billet: event.target.value as BattalionRosterPlayer["billet"] }
                              }))
                            }
                          >
                            <option value="trooper">Trooper</option>
                            <option value="squad_lead">Squad lead</option>
                            <option value="fireteam_lead">Fireteam lead</option>
                            <option value="unassigned">Unassigned</option>
                          </select>
                        ) : (
                          player.billet.replaceAll("_", " ")
                        )}
                      </td>
                      {canManage ? (
                        <td>
                          {playerUid ? (
                            <button type="button" className="danger" onClick={() => void removePlayer(playerUid)}>
                              Remove
                            </button>
                          ) : (
                            <StatusChip label="restricted" tone="muted" />
                          )}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </TacticalTable>
            {canManage ? (
              <section className="candidate-roster">
                <div className="panel-heading slim">
                  <h3>Available Players</h3>
                  <button type="button" onClick={() => void loadPlayerCandidates(selectedUnitId, candidateSearch)}>
                    Search
                  </button>
                </div>
                <form className="filters roster-filter" onSubmit={(event) => event.preventDefault()}>
                  <input
                    value={candidateSearch}
                    onChange={(event) => setCandidateSearch(event.target.value)}
                    placeholder="Search unassigned players"
                    aria-label="Search unassigned players"
                  />
                  <button type="button" onClick={() => void loadPlayerCandidates(selectedUnitId, candidateSearch)}>
                    Refresh
                  </button>
                </form>
                <DataMessage result={playerCandidates} />
                {playerCandidates.status === "ready" ? (
                  <TacticalTable label="Available players" maxVisibleRows={6}>
                    <thead>
                      <tr>
                        <th>Player</th>
                        <th>Last Seen</th>
                        <th>Ops</th>
                        <th>Add</th>
                      </tr>
                    </thead>
                    <tbody>
                      {playerCandidates.data.players.map((player) => (
                        <tr key={player.player_uid}>
                          <td>
                            <strong>{displayValue(player.last_name)}</strong>
                            <p className="mono">{player.player_uid}</p>
                          </td>
                          <td>{formatDate(player.last_seen_at)}</td>
                          <td>{player.operation_count}</td>
                          <td>
                            <button type="button" onClick={() => void addCandidatePlayer(player.player_uid, player.last_name)}>
                              Add
                            </button>
                          </td>
                        </tr>
                      ))}
                      {playerCandidates.data.players.length === 0 ? (
                        <tr>
                          <td colSpan={4}>No unassigned players found.</td>
                        </tr>
                      ) : null}
                    </tbody>
                  </TacticalTable>
                ) : null}
              </section>
            ) : null}
          </>
        ) : null}
      </CommandPanel>

      <CommandPanel title="Squad Layout" eyebrow="Tree control">
        {rosterData && allSquads.length > 0 ? (
          <div className="squad-tree">
            {allSquads.map((squad) => (
              <div key={squad.id} className="squad-node">
                <div>
                  <strong>{squad.name}</strong>
                  <span>{squad.squad_type}</span>
                </div>
                <p>{squad.leader ? `Lead: ${squad.leader.roster_name}` : "No lead assigned"}</p>
                {canManage ? (
                  <button type="button" className="danger" onClick={() => void deleteSquad(squad)}>
                    Delete
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="empty-copy">Create the first squad or keep this battalion flat.</p>
        )}
        {canManage ? (
          <div className="inline-actions layout-actions">
            <button type="button" onClick={() => void saveLayout()}>
              Save layout
            </button>
          </div>
        ) : null}
      </CommandPanel>

      {canManage ? (
        <CommandPanel title="Command Assignment" eyebrow="Admin controls" wide>
          <div className="battalion-forms">
            {isOwner(user) ? (
              <form className="filters battalion-form" onSubmit={(event) => event.preventDefault()}>
                <input value={newUnit.unit_key} onChange={(event) => setNewUnit({ ...newUnit, unit_key: event.target.value })} placeholder="battalion-key" />
                <input value={newUnit.name} onChange={(event) => setNewUnit({ ...newUnit, name: event.target.value })} placeholder="Battalion name" />
                <input value={newUnit.callsign} onChange={(event) => setNewUnit({ ...newUnit, callsign: event.target.value })} placeholder="Callsign" />
                <button type="button" onClick={() => void createUnit()} disabled={!newUnit.name.trim()}>
                  Create battalion
                </button>
              </form>
            ) : null}

            {selectedUnit ? (
              <>
                <form className="filters battalion-form" onSubmit={(event) => event.preventDefault()}>
                  <input value={newPlayer.player_uid} onChange={(event) => setNewPlayer({ ...newPlayer, player_uid: event.target.value })} placeholder="Player UID" />
                  <input value={newPlayer.roster_name} onChange={(event) => setNewPlayer({ ...newPlayer, roster_name: event.target.value })} placeholder="Roster name" />
                  <input value={newPlayer.rank} onChange={(event) => setNewPlayer({ ...newPlayer, rank: event.target.value })} placeholder="Rank" />
                  <button type="button" onClick={() => void addPlayer()} disabled={!newPlayer.player_uid}>
                    Add trooper
                  </button>
                </form>
                <form className="filters battalion-form" onSubmit={(event) => event.preventDefault()}>
                  <input value={newSquad.squad_key} onChange={(event) => setNewSquad({ ...newSquad, squad_key: event.target.value })} placeholder="Squad key" />
                  <input value={newSquad.name} onChange={(event) => setNewSquad({ ...newSquad, name: event.target.value })} placeholder="Squad name" />
                  <select value={newSquad.parent_squad_id} onChange={(event) => setNewSquad({ ...newSquad, parent_squad_id: event.target.value })}>
                    <option value="">No parent</option>
                    {allSquads.map((squad) => (
                      <option key={squad.id} value={squad.id}>
                        {squad.name}
                      </option>
                    ))}
                  </select>
                  <select value={newSquad.squad_type} onChange={(event) => setNewSquad({ ...newSquad, squad_type: event.target.value })}>
                    <option value="squad">Squad</option>
                    <option value="fireteam">Fireteam</option>
                    <option value="platoon">Platoon</option>
                    <option value="company">Company</option>
                    <option value="detachment">Detachment</option>
                  </select>
                  <button type="button" onClick={() => void createSquad()} disabled={!newSquad.squad_key || !newSquad.name}>
                    Create squad
                  </button>
                </form>
                <form className="filters battalion-form" onSubmit={(event) => event.preventDefault()}>
                  <input value={newRank.rank_key} onChange={(event) => setNewRank({ ...newRank, rank_key: event.target.value })} placeholder="Rank key" />
                  <input value={newRank.name} onChange={(event) => setNewRank({ ...newRank, name: event.target.value })} placeholder="Rank name" />
                  <input value={newRank.short_name} onChange={(event) => setNewRank({ ...newRank, short_name: event.target.value })} placeholder="Short" />
                  <input value={newRank.sort_order} onChange={(event) => setNewRank({ ...newRank, sort_order: event.target.value })} placeholder="Sort" />
                  <button type="button" onClick={() => void createRank()} disabled={!newRank.rank_key || !newRank.name}>
                    Add rank
                  </button>
                </form>
              </>
            ) : null}

            {isOwner(user) && selectedUnit ? (
              <>
                <form className="filters battalion-form" onSubmit={(event) => event.preventDefault()}>
                  <input value={adminGrant.user_id} onChange={(event) => setAdminGrant({ ...adminGrant, user_id: event.target.value })} placeholder="User UUID" />
                  <select value={adminGrant.role} onChange={(event) => setAdminGrant({ ...adminGrant, role: event.target.value })}>
                    <option value="officer">Officer</option>
                    <option value="admin">Admin</option>
                    <option value="tcw_admin">TCW admin</option>
                  </select>
                  <button type="button" onClick={() => void grantUnitAdmin()} disabled={!adminGrant.user_id}>
                    Grant role
                  </button>
                  <button type="button" className="danger" onClick={() => void deleteUnit()}>
                    Deactivate battalion
                  </button>
                </form>
              </>
            ) : null}
          </div>
        </CommandPanel>
      ) : null}
    </div>
  );
}
