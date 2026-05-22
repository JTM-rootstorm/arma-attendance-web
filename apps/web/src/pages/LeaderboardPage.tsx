import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../api";
import { CommandPanel } from "../components/CommandPanel";
import { MetricTile } from "../components/MetricTile";
import { TacticalTable } from "../components/TacticalTable";
import type { ApiResult, UnitLeaderboardResponse } from "../types";

const emptyLeaderboard: ApiResult<UnitLeaderboardResponse> = { status: "idle", data: null, error: null };

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
  const [leaderboard, setLeaderboard] = useState<ApiResult<UnitLeaderboardResponse>>(emptyLeaderboard);
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

  useEffect(() => {
    void loadLeaderboard();
  }, [loadLeaderboard]);

  const rows = leaderboard.status === "ready" ? leaderboard.data.leaderboard : [];
  const topThree = rows.slice(0, 3);

  return (
    <div className="view-grid leaderboard-view">
      <CommandPanel
        title="Leaderboard"
        eyebrow="Battalion holo-ranking"
        wide
        actions={
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
        }
      >
        <DataMessage result={leaderboard} />
        {topThree.length > 0 ? (
          <div className="leaderboard-podium">
            {topThree.map((entry) => (
              <MetricTile key={`${entry.rank}-${entry.name}`} label={`#${entry.rank} ${topLabel(entry.rank)}`} value={entry.name} detail={`${entry.total_kills} kills`} />
            ))}
          </div>
        ) : leaderboard.status === "ready" ? (
          <p className="empty-copy">No scored operations yet.</p>
        ) : null}
      </CommandPanel>

      <CommandPanel title="Kill Matrix" eyebrow="Score split" wide>
        {rows.length > 0 ? (
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
              {rows.map((entry) => (
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
    </div>
  );
}
