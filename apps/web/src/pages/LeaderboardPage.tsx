import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../api";
import { CommandPanel } from "../components/CommandPanel";
import { MetricTile } from "../components/MetricTile";
import { TacticalTable } from "../components/TacticalTable";
import type { ApiResult, PlayerLeaderboardResponse, UnitLeaderboardResponse } from "../types";

const emptyLeaderboard: ApiResult<UnitLeaderboardResponse> = { status: "idle", data: null, error: null };
const emptyPlayerLeaderboard: ApiResult<PlayerLeaderboardResponse> = { status: "idle", data: null, error: null };
type LeaderboardBoard = "units" | "players";

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

function topLabel(rank: number): string {
  if (rank === 1) {
    return "Command Standard";
  }

  if (rank === 2) {
    return "Assault Wing";
  }

  if (rank === 3) {
    return "Forward Element";
  }

  return "Line Battalion";
}

export function LeaderboardPage() {
  const [activeBoard, setActiveBoard] = useState<LeaderboardBoard>("units");
  const [leaderboard, setLeaderboard] = useState<ApiResult<UnitLeaderboardResponse>>(emptyLeaderboard);
  const [playerLeaderboard, setPlayerLeaderboard] = useState<ApiResult<PlayerLeaderboardResponse>>(emptyPlayerLeaderboard);
  const [lookbackDays, setLookbackDays] = useState("");
  const [minOperations, setMinOperations] = useState("");

  const loadLeaderboard = useCallback(async () => {
    setLeaderboard({ status: "loading", data: null, error: null });

    try {
      setLeaderboard({
        status: "ready",
        data: await apiFetch<UnitLeaderboardResponse>("/v1/leaderboard/units", {
          params: {
            limit: "50",
            lookback_days: lookbackDays,
            min_operations: minOperations
          }
        }),
        error: null
      });
    } catch (error) {
      setLeaderboard(errorResult(error, "Leaderboard failed."));
    }
  }, [lookbackDays, minOperations]);

  const loadPlayerLeaderboard = useCallback(async () => {
    setPlayerLeaderboard({ status: "loading", data: null, error: null });

    try {
      setPlayerLeaderboard({
        status: "ready",
        data: await apiFetch<PlayerLeaderboardResponse>("/public/leaderboard/players", {
          params: { limit: "20" }
        }),
        error: null
      });
    } catch (error) {
      setPlayerLeaderboard(errorResult(error, "Player leaderboard failed."));
    }
  }, []);

  useEffect(() => {
    if (activeBoard === "units") {
      void loadLeaderboard();
      return;
    }

    void loadPlayerLeaderboard();
  }, [activeBoard, loadLeaderboard, loadPlayerLeaderboard]);

  const unitRows = leaderboard.status === "ready" ? leaderboard.data.leaderboard : [];
  const playerRows = playerLeaderboard.status === "ready" ? playerLeaderboard.data.leaderboard : [];
  const rows = activeBoard === "units" ? unitRows : playerRows;
  const topThree = rows.slice(0, 3);

  return (
    <div className="view-grid leaderboard-view">
      <CommandPanel
        title="Leaderboard"
        eyebrow="Battalion holo-ranking"
        wide
        actions={
          activeBoard === "units" ? (
            <div className="inline-actions">
              <input value={lookbackDays} onChange={(event) => setLookbackDays(event.target.value)} placeholder="Lookback days" aria-label="Lookback days" />
              <input
                value={minOperations}
                onChange={(event) => setMinOperations(event.target.value)}
                placeholder="Min ops"
                aria-label="Minimum operations"
              />
              <button type="button" onClick={() => void loadLeaderboard()}>
                Refresh
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => void loadPlayerLeaderboard()}>
              Refresh
            </button>
          )
        }
      >
        <div className="leaderboard-tabs" aria-label="Leaderboard boards">
          <button type="button" className={activeBoard === "units" ? "active" : undefined} aria-pressed={activeBoard === "units"} onClick={() => setActiveBoard("units")}>
            Units
          </button>
          <button
            type="button"
            className={activeBoard === "players" ? "active" : undefined}
            aria-pressed={activeBoard === "players"}
            onClick={() => setActiveBoard("players")}
          >
            Players
          </button>
        </div>
        <DataMessage result={activeBoard === "units" ? leaderboard : playerLeaderboard} />
        {topThree.length > 0 ? (
          <div className="leaderboard-podium">
            {topThree.map((entry) => (
              <MetricTile key={`${entry.rank}-${entry.name}`} label={`#${entry.rank} ${topLabel(entry.rank)}`} value={entry.name} detail={`${entry.total_kills} kills`} />
            ))}
          </div>
        ) : activeBoard === "units" && leaderboard.status === "ready" ? (
          <p className="empty-copy">No scored unit operations yet.</p>
        ) : activeBoard === "players" && playerLeaderboard.status === "ready" ? (
          <p className="empty-copy">No scored player operations yet.</p>
        ) : null}
      </CommandPanel>

      {activeBoard === "units" ? (
        <CommandPanel title="Kill Matrix" eyebrow="Score split" wide>
          {unitRows.length > 0 ? (
            <TacticalTable label="Battalion leaderboard" maxVisibleRows={14} className="static-table">
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Battalion</th>
                  <th>Total</th>
                  <th>Infantry</th>
                  <th>Soft Armor</th>
                  <th>Armor</th>
                  <th>Plane</th>
                  <th>Deaths</th>
                  <th>Members</th>
                  <th>Ops</th>
                </tr>
              </thead>
              <tbody>
                {unitRows.map((entry) => (
                  <tr key={`${entry.rank}-${entry.name}`}>
                    <td>#{entry.rank}</td>
                    <td>
                      <strong>{entry.name}</strong>
                    </td>
                    <td>{entry.total_kills}</td>
                    <td>{entry.infantry_kills}</td>
                    <td>{entry.soft_vehicle_kills}</td>
                    <td>{entry.armor_kills}</td>
                    <td>{entry.air_kills}</td>
                    <td>{entry.deaths}</td>
                    <td>{entry.member_count}</td>
                    <td>{entry.operation_count}</td>
                  </tr>
                ))}
              </tbody>
            </TacticalTable>
          ) : null}
        </CommandPanel>
      ) : (
        <CommandPanel title="Player Leaderboard" eyebrow="Top 20 public combat ranking" wide>
          {playerRows.length > 0 ? (
            <TacticalTable label="Player leaderboard" maxVisibleRows={14} className="static-table">
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Player</th>
                  <th>Total</th>
                  <th>Infantry</th>
                  <th>Soft Armor</th>
                  <th>Armor</th>
                  <th>Plane</th>
                  <th>Deaths</th>
                  <th>Ops</th>
                </tr>
              </thead>
              <tbody>
                {playerRows.map((entry) => (
                  <tr key={`${entry.rank}-${entry.name}`}>
                    <td>#{entry.rank}</td>
                    <td>
                      <strong>{entry.name}</strong>
                    </td>
                    <td>{entry.total_kills}</td>
                    <td>{entry.infantry_kills}</td>
                    <td>{entry.soft_vehicle_kills}</td>
                    <td>{entry.armor_kills}</td>
                    <td>{entry.air_kills}</td>
                    <td>{entry.deaths}</td>
                    <td>{entry.operation_count}</td>
                  </tr>
                ))}
              </tbody>
            </TacticalTable>
          ) : null}
        </CommandPanel>
      )}
    </div>
  );
}
