import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";
const tokenStorageKey = "arma-attendance-api-token";

type ApiError = {
  code: string;
  message: string;
};

type ApiResult<T> =
  | {
      status: "idle" | "loading";
      data: null;
      error: null;
    }
  | {
      status: "ready";
      data: T;
      error: null;
    }
  | {
      status: "error";
      data: null;
      error: string;
    };

function hasApiError(value: unknown): value is { error: ApiError } {
  return typeof value === "object" && value !== null && "error" in value;
}

type HealthResponse = {
  ok: boolean;
  service: string;
  version: string;
  time: string;
};

type DbHealthResponse = {
  ok: boolean;
  database: {
    connected: boolean;
    current_database: string;
    server_time: string;
  };
};

type OperationStatus = "started" | "finished" | "abandoned";

type OperationListItem = {
  id: string;
  server_key: string;
  status: OperationStatus;
  mission_uid: string | null;
  mission_name: string | null;
  world_name: string | null;
  started_at: string;
  ended_at: string | null;
  payload_count: number;
};

type DashboardSummaryResponse = {
  ok: true;
  summary: {
    operations_total: number;
    operations_started: number;
    operations_finished: number;
    players_total: number;
    attendance_rows_total: number;
    stats_rows_total: number;
    last_operation_at: string | null;
  };
  recent_operations: Array<OperationListItem & { attendance_count: number }>;
  top_players_by_attendance: Array<{
    player_uid: string;
    last_name: string | null;
    operation_count: number;
  }>;
  top_players_by_ai_kills: Array<{
    player_uid: string;
    last_name: string | null;
    ai_kills: number;
  }>;
};

type OperationsResponse = {
  ok: true;
  operations: OperationListItem[];
};

type OperationDetailResponse = {
  ok: true;
  operation: OperationListItem & {
    raw_start_payload: unknown;
    raw_end_payload: unknown;
  };
  payloads: Array<{
    id: string;
    kind: "start" | "finish";
    request_id: string;
    received_at: string;
  }>;
};

type OperationSummaryResponse = {
  ok: true;
  attendance: {
    present_at_start: number;
    present_at_end: number;
    start_only: number;
    end_only: number;
    both_start_and_end: number;
  };
  stats: {
    infantry_kills: number;
    vehicle_kills: number;
    player_kills: number;
    ai_kills: number;
    friendly_kills: number;
    deaths: number;
  };
  payloads: {
    total: number;
    start: number;
    finish: number;
  };
};

type OperationAttendanceResponse = {
  ok: true;
  attendance: Array<{
    player_uid: string;
    name_at_start: string | null;
    name_at_end: string | null;
    side_at_start: string | null;
    side_at_end: string | null;
    group_at_start: string | null;
    group_at_end: string | null;
    role_at_start: string | null;
    role_at_end: string | null;
    present_at_start: boolean;
    present_at_end: boolean;
    stats: {
      infantry_kills: number;
      vehicle_kills: number;
      player_kills: number;
      ai_kills: number;
      friendly_kills: number;
      deaths: number;
    } | null;
  }>;
};

type PlayersResponse = {
  ok: true;
  players: Array<{
    player_uid: string;
    last_name: string | null;
    first_seen_at: string;
    last_seen_at: string;
    operation_count: number;
  }>;
};

type PlayerDetailResponse = {
  ok: true;
  player: {
    player_uid: string;
    last_name: string | null;
    first_seen_at: string;
    last_seen_at: string;
  };
  recent_operations: Array<{
    operation_id: string;
    server_key: string;
    status: OperationStatus;
    mission_uid: string | null;
    mission_name: string | null;
    world_name: string | null;
    started_at: string;
    ended_at: string | null;
    present_at_start: boolean;
    present_at_end: boolean;
    stats: OperationSummaryResponse["stats"] | null;
  }>;
};

type PlayerSummaryResponse = {
  ok: true;
  summary: {
    operation_count: number;
    present_at_start_count: number;
    present_at_end_count: number;
    infantry_kills: number;
    vehicle_kills: number;
    player_kills: number;
    ai_kills: number;
    friendly_kills: number;
    deaths: number;
  };
  recent_operations: Array<{
    operation_id: string;
    server_key: string;
    status: OperationStatus;
    mission_name: string | null;
    started_at: string;
    ended_at: string | null;
    present_at_start: boolean;
    present_at_end: boolean;
  }>;
};

type ViewName = "summary" | "operations" | "players";

const emptyResult: ApiResult<never> = {
  status: "idle",
  data: null,
  error: null
};

function buildUrl(path: string, params?: Record<string, string | undefined>): string {
  const url = new URL(path, apiBaseUrl || window.location.origin);

  for (const [key, value] of Object.entries(params ?? {})) {
    if (value && value.trim().length > 0) {
      url.searchParams.set(key, value.trim());
    }
  }

  return url.toString();
}

async function readJson<T>(path: string, token?: string, params?: Record<string, string | undefined>): Promise<T> {
  const headers = new Headers();

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(buildUrl(path, params), { headers });
  const data = (await response.json()) as T | { ok: false; error: ApiError };

  if (!response.ok) {
    const error = hasApiError(data) ? data.error.message : `Request failed with HTTP ${response.status}`;
    throw new Error(error);
  }

  return data as T;
}

async function fetchCsv(path: string, token: string): Promise<string> {
  const response = await fetch(buildUrl(path), {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`CSV export failed with HTTP ${response.status}`);
  }

  return response.text();
}

function getStoredToken(): string {
  return window.sessionStorage.getItem(tokenStorageKey) ?? "";
}

function formatDate(value: string | null): string {
  if (!value) {
    return "—";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));
}

function display(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "—";
  }

  return String(value);
}

function statusLabel(result: ApiResult<unknown>): string {
  if (result.status === "loading") {
    return "checking";
  }

  if (result.status === "ready") {
    return "online";
  }

  if (result.status === "error") {
    return "error";
  }

  return "idle";
}

function StatTile({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div className="stat-tile">
      <span>{label}</span>
      <strong>{display(value)}</strong>
    </div>
  );
}

function Message({ result }: { result: ApiResult<unknown> }) {
  if (result.status === "loading") {
    return <p className="message">Loading…</p>;
  }

  if (result.status === "error") {
    return <p className="message error">{result.error}</p>;
  }

  return null;
}

export function App() {
  const [token, setToken] = useState(getStoredToken);
  const [tokenDraft, setTokenDraft] = useState(token);
  const [view, setView] = useState<ViewName>("summary");
  const [health, setHealth] = useState<ApiResult<HealthResponse>>(emptyResult);
  const [dbHealth, setDbHealth] = useState<ApiResult<DbHealthResponse>>(emptyResult);
  const [summary, setSummary] = useState<ApiResult<DashboardSummaryResponse>>(emptyResult);
  const [operations, setOperations] = useState<ApiResult<OperationsResponse>>(emptyResult);
  const [operationDetail, setOperationDetail] = useState<ApiResult<OperationDetailResponse>>(emptyResult);
  const [operationSummary, setOperationSummary] = useState<ApiResult<OperationSummaryResponse>>(emptyResult);
  const [operationAttendance, setOperationAttendance] = useState<ApiResult<OperationAttendanceResponse>>(emptyResult);
  const [players, setPlayers] = useState<ApiResult<PlayersResponse>>(emptyResult);
  const [playerDetail, setPlayerDetail] = useState<ApiResult<PlayerDetailResponse>>(emptyResult);
  const [playerSummary, setPlayerSummary] = useState<ApiResult<PlayerSummaryResponse>>(emptyResult);
  const [operationFilters, setOperationFilters] = useState({ server_key: "", status: "", mission_uid: "" });
  const [playerSearch, setPlayerSearch] = useState("");
  const [selectedOperationId, setSelectedOperationId] = useState("");
  const [selectedPlayerUid, setSelectedPlayerUid] = useState("");
  const [exportMessage, setExportMessage] = useState("");

  const hasToken = token.trim().length > 0;

  const loadHealth = useCallback(async () => {
    setHealth({ status: "loading", data: null, error: null });

    try {
      setHealth({ status: "ready", data: await readJson<HealthResponse>("/health"), error: null });
    } catch (error) {
      setHealth({ status: "error", data: null, error: error instanceof Error ? error.message : "Health check failed." });
    }
  }, []);

  const loadDbHealth = useCallback(async () => {
    if (!hasToken) {
      setDbHealth(emptyResult);
      return;
    }

    setDbHealth({ status: "loading", data: null, error: null });

    try {
      setDbHealth({ status: "ready", data: await readJson<DbHealthResponse>("/health/db", token), error: null });
    } catch (error) {
      setDbHealth({ status: "error", data: null, error: error instanceof Error ? error.message : "DB health failed." });
    }
  }, [hasToken, token]);

  const loadSummary = useCallback(async () => {
    if (!hasToken) {
      return;
    }

    setSummary({ status: "loading", data: null, error: null });

    try {
      setSummary({
        status: "ready",
        data: await readJson<DashboardSummaryResponse>("/v1/dashboard/summary", token),
        error: null
      });
    } catch (error) {
      setSummary({ status: "error", data: null, error: error instanceof Error ? error.message : "Summary failed." });
    }
  }, [hasToken, token]);

  const loadOperations = useCallback(async () => {
    if (!hasToken) {
      return;
    }

    setOperations({ status: "loading", data: null, error: null });

    try {
      setOperations({
        status: "ready",
        data: await readJson<OperationsResponse>("/v1/operations", token, {
          ...operationFilters,
          limit: "50"
        }),
        error: null
      });
    } catch (error) {
      setOperations({ status: "error", data: null, error: error instanceof Error ? error.message : "Operations failed." });
    }
  }, [hasToken, operationFilters, token]);

  const loadPlayers = useCallback(async () => {
    if (!hasToken) {
      return;
    }

    setPlayers({ status: "loading", data: null, error: null });

    try {
      setPlayers({
        status: "ready",
        data: await readJson<PlayersResponse>("/v1/players", token, { q: playerSearch, limit: "50" }),
        error: null
      });
    } catch (error) {
      setPlayers({ status: "error", data: null, error: error instanceof Error ? error.message : "Players failed." });
    }
  }, [hasToken, playerSearch, token]);

  const loadOperationDetail = useCallback(
    async (operationId: string) => {
      if (!hasToken || operationId.length === 0) {
        return;
      }

      setOperationDetail({ status: "loading", data: null, error: null });
      setOperationSummary({ status: "loading", data: null, error: null });
      setOperationAttendance({ status: "loading", data: null, error: null });

      try {
        const [detail, detailSummary, attendance] = await Promise.all([
          readJson<OperationDetailResponse>(`/v1/operations/${operationId}`, token),
          readJson<OperationSummaryResponse>(`/v1/operations/${operationId}/summary`, token),
          readJson<OperationAttendanceResponse>(`/v1/operations/${operationId}/attendance`, token)
        ]);

        setOperationDetail({ status: "ready", data: detail, error: null });
        setOperationSummary({ status: "ready", data: detailSummary, error: null });
        setOperationAttendance({ status: "ready", data: attendance, error: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Operation detail failed.";
        setOperationDetail({ status: "error", data: null, error: message });
        setOperationSummary({ status: "error", data: null, error: message });
        setOperationAttendance({ status: "error", data: null, error: message });
      }
    },
    [hasToken, token]
  );

  const loadPlayerDetail = useCallback(
    async (playerUid: string) => {
      if (!hasToken || playerUid.length === 0) {
        return;
      }

      setPlayerDetail({ status: "loading", data: null, error: null });
      setPlayerSummary({ status: "loading", data: null, error: null });

      try {
        const [detail, detailSummary] = await Promise.all([
          readJson<PlayerDetailResponse>(`/v1/players/${encodeURIComponent(playerUid)}`, token),
          readJson<PlayerSummaryResponse>(`/v1/players/${encodeURIComponent(playerUid)}/summary`, token)
        ]);

        setPlayerDetail({ status: "ready", data: detail, error: null });
        setPlayerSummary({ status: "ready", data: detailSummary, error: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Player detail failed.";
        setPlayerDetail({ status: "error", data: null, error: message });
        setPlayerSummary({ status: "error", data: null, error: message });
      }
    },
    [hasToken, token]
  );

  useEffect(() => {
    void loadHealth();
  }, [loadHealth]);

  useEffect(() => {
    void loadDbHealth();
    void loadSummary();
    void loadOperations();
    void loadPlayers();
  }, [loadDbHealth, loadOperations, loadPlayers, loadSummary]);

  useEffect(() => {
    if (selectedOperationId) {
      void loadOperationDetail(selectedOperationId);
    }
  }, [loadOperationDetail, selectedOperationId]);

  useEffect(() => {
    if (selectedPlayerUid) {
      void loadPlayerDetail(selectedPlayerUid);
    }
  }, [loadPlayerDetail, selectedPlayerUid]);

  const selectedOperation = useMemo(
    () => operations.status === "ready" ? operations.data.operations.find((operation) => operation.id === selectedOperationId) : null,
    [operations, selectedOperationId]
  );

  function saveToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextToken = tokenDraft.trim();
    window.sessionStorage.setItem(tokenStorageKey, nextToken);
    setToken(nextToken);
  }

  function forgetToken() {
    window.sessionStorage.removeItem(tokenStorageKey);
    setToken("");
    setTokenDraft("");
    setSummary(emptyResult);
    setOperations(emptyResult);
    setPlayers(emptyResult);
    setOperationDetail(emptyResult);
    setOperationSummary(emptyResult);
    setOperationAttendance(emptyResult);
    setPlayerDetail(emptyResult);
    setPlayerSummary(emptyResult);
  }

  async function exportCsv(path: string, filename: string) {
    if (!hasToken) {
      setExportMessage("Token required.");
      return;
    }

    try {
      const csv = await fetchCsv(path, token);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
      setExportMessage(`Export ready: ${filename}`);
    } catch (error) {
      setExportMessage(error instanceof Error ? error.message : "Export failed.");
    }
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <p className="eyebrow">Internal</p>
          <h1>Arma Attendance Tracker</h1>
        </div>
        <div className="status-strip" aria-label="Service status">
          <span className={`status-pill ${health.status}`}>API {statusLabel(health)}</span>
          <span className={`status-pill ${dbHealth.status}`}>DB {hasToken ? statusLabel(dbHealth) : "token needed"}</span>
          <span className={`status-pill ${hasToken ? "ready" : "idle"}`}>{hasToken ? "token set" : "no token"}</span>
        </div>
      </header>

      <section className="auth-panel" aria-label="Bearer token">
        <form onSubmit={saveToken}>
          <label htmlFor="token">Bearer token</label>
          <input
            id="token"
            type="password"
            value={tokenDraft}
            onChange={(event) => setTokenDraft(event.target.value)}
            placeholder="dev-token"
            autoComplete="off"
          />
          <button type="submit">Use token</button>
          <button type="button" className="secondary" onClick={forgetToken}>
            Forget token
          </button>
        </form>
      </section>

      <nav className="tabs" aria-label="Dashboard views">
        {(["summary", "operations", "players"] as ViewName[]).map((name) => (
          <button key={name} className={view === name ? "active" : ""} type="button" onClick={() => setView(name)}>
            {name}
          </button>
        ))}
      </nav>

      {!hasToken ? <p className="message">Enter a bearer token to load internal API data.</p> : null}

      {view === "summary" ? (
        <section className="view-grid">
          <Message result={summary} />
          {summary.status === "ready" ? (
            <>
              <section className="panel">
                <h2>Summary</h2>
                <div className="stat-grid">
                  <StatTile label="Operations" value={summary.data.summary.operations_total} />
                  <StatTile label="Finished" value={summary.data.summary.operations_finished} />
                  <StatTile label="Started" value={summary.data.summary.operations_started} />
                  <StatTile label="Players" value={summary.data.summary.players_total} />
                  <StatTile label="Attendance rows" value={summary.data.summary.attendance_rows_total} />
                  <StatTile label="Stats rows" value={summary.data.summary.stats_rows_total} />
                </div>
              </section>
              <section className="panel wide">
                <h2>Recent operations</h2>
                <OperationsTable
                  operations={summary.data.recent_operations}
                  onSelect={(operationId) => {
                    setSelectedOperationId(operationId);
                    setView("operations");
                  }}
                />
              </section>
              <section className="panel">
                <h2>Top attendance</h2>
                <PlayerRankTable rows={summary.data.top_players_by_attendance} metricKey="operation_count" metricLabel="Ops" />
              </section>
              <section className="panel">
                <h2>Top AI kills</h2>
                <PlayerRankTable rows={summary.data.top_players_by_ai_kills} metricKey="ai_kills" metricLabel="AI" />
              </section>
            </>
          ) : null}
        </section>
      ) : null}

      {view === "operations" ? (
        <section className="view-grid">
          <section className="panel wide">
            <div className="panel-header">
              <h2>Operations</h2>
              <button type="button" onClick={() => void loadOperations()}>
                Refresh
              </button>
            </div>
            <form className="filters" onSubmit={(event) => event.preventDefault()}>
              <input
                value={operationFilters.server_key}
                onChange={(event) => setOperationFilters((current) => ({ ...current, server_key: event.target.value }))}
                placeholder="server_key"
              />
              <select
                value={operationFilters.status}
                onChange={(event) => setOperationFilters((current) => ({ ...current, status: event.target.value }))}
              >
                <option value="">any status</option>
                <option value="started">started</option>
                <option value="finished">finished</option>
                <option value="abandoned">abandoned</option>
              </select>
              <input
                value={operationFilters.mission_uid}
                onChange={(event) => setOperationFilters((current) => ({ ...current, mission_uid: event.target.value }))}
                placeholder="mission_uid"
              />
            </form>
            <Message result={operations} />
            {operations.status === "ready" ? (
              <OperationsTable operations={operations.data.operations} selectedId={selectedOperationId} onSelect={setSelectedOperationId} />
            ) : null}
          </section>
          <section className="panel wide">
            <div className="panel-header">
              <h2>Operation detail</h2>
              {selectedOperation ? (
                <button
                  type="button"
                  onClick={() => void exportCsv(`/v1/operations/${selectedOperation.id}/attendance.csv`, `operation-${selectedOperation.id}-attendance.csv`)}
                >
                  Attendance CSV
                </button>
              ) : null}
            </div>
            {exportMessage ? <p className="message">{exportMessage}</p> : null}
            <Message result={operationDetail} />
            <Message result={operationSummary} />
            <Message result={operationAttendance} />
            {operationDetail.status === "ready" && operationSummary.status === "ready" ? (
              <div className="detail-block">
                <h3>{display(operationDetail.data.operation.mission_name)}</h3>
                <div className="stat-grid compact">
                  <StatTile label="Server" value={operationDetail.data.operation.server_key} />
                  <StatTile label="Status" value={operationDetail.data.operation.status} />
                  <StatTile label="Payloads" value={operationSummary.data.payloads.total} />
                  <StatTile label="Start present" value={operationSummary.data.attendance.present_at_start} />
                  <StatTile label="End present" value={operationSummary.data.attendance.present_at_end} />
                  <StatTile label="AI kills" value={operationSummary.data.stats.ai_kills} />
                  <StatTile label="Deaths" value={operationSummary.data.stats.deaths} />
                </div>
              </div>
            ) : null}
            {operationAttendance.status === "ready" ? <AttendanceTable rows={operationAttendance.data.attendance} /> : null}
          </section>
        </section>
      ) : null}

      {view === "players" ? (
        <section className="view-grid">
          <section className="panel wide">
            <div className="panel-header">
              <h2>Players</h2>
              <button type="button" onClick={() => void exportCsv(`/v1/players.csv?q=${encodeURIComponent(playerSearch)}`, "players.csv")}>
                Players CSV
              </button>
            </div>
            <form className="filters" onSubmit={(event) => event.preventDefault()}>
              <input value={playerSearch} onChange={(event) => setPlayerSearch(event.target.value)} placeholder="Search players" />
              <button type="button" onClick={() => void loadPlayers()}>
                Search
              </button>
            </form>
            <Message result={players} />
            {players.status === "ready" ? (
              <table>
                <thead>
                  <tr>
                    <th>Player UID</th>
                    <th>Name</th>
                    <th>Last seen</th>
                    <th>Ops</th>
                  </tr>
                </thead>
                <tbody>
                  {players.data.players.map((player) => (
                    <tr
                      key={player.player_uid}
                      className={player.player_uid === selectedPlayerUid ? "selected" : ""}
                      onClick={() => setSelectedPlayerUid(player.player_uid)}
                    >
                      <td>{player.player_uid}</td>
                      <td>{display(player.last_name)}</td>
                      <td>{formatDate(player.last_seen_at)}</td>
                      <td>{player.operation_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </section>
          <section className="panel wide">
            <h2>Player detail</h2>
            <Message result={playerDetail} />
            <Message result={playerSummary} />
            {playerDetail.status === "ready" && playerSummary.status === "ready" ? (
              <div className="detail-block">
                <h3>{display(playerDetail.data.player.last_name)}</h3>
                <p className="mono">{playerDetail.data.player.player_uid}</p>
                <div className="stat-grid compact">
                  <StatTile label="Operations" value={playerSummary.data.summary.operation_count} />
                  <StatTile label="Start count" value={playerSummary.data.summary.present_at_start_count} />
                  <StatTile label="End count" value={playerSummary.data.summary.present_at_end_count} />
                  <StatTile label="AI kills" value={playerSummary.data.summary.ai_kills} />
                  <StatTile label="Deaths" value={playerSummary.data.summary.deaths} />
                </div>
                <h3>Recent operations</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Mission</th>
                      <th>Status</th>
                      <th>Started</th>
                      <th>Present</th>
                    </tr>
                  </thead>
                  <tbody>
                    {playerSummary.data.recent_operations.map((operation) => (
                      <tr key={operation.operation_id}>
                        <td>{display(operation.mission_name)}</td>
                        <td>{operation.status}</td>
                        <td>{formatDate(operation.started_at)}</td>
                        <td>{operation.present_at_start || operation.present_at_end ? "yes" : "no"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
        </section>
      ) : null}
    </main>
  );
}

function OperationsTable({
  operations,
  selectedId,
  onSelect
}: {
  operations: OperationListItem[];
  selectedId?: string;
  onSelect: (operationId: string) => void;
}) {
  return (
    <table>
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
            <td>{display(operation.mission_name)}</td>
            <td>{display(operation.world_name)}</td>
            <td>{operation.server_key}</td>
            <td>{operation.status}</td>
            <td>{formatDate(operation.started_at)}</td>
            <td>{operation.payload_count}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PlayerRankTable({
  rows,
  metricKey,
  metricLabel
}: {
  rows: Array<{ player_uid: string; last_name: string | null } & Record<string, string | number | null>>;
  metricKey: string;
  metricLabel: string;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>Player</th>
          <th>{metricLabel}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.player_uid}>
            <td>{display(row.last_name) !== "—" ? display(row.last_name) : row.player_uid}</td>
            <td>{display(row[metricKey])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AttendanceTable({ rows }: { rows: OperationAttendanceResponse["attendance"] }) {
  return (
    <table>
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
            <td>{row.player_uid}</td>
            <td>{display(row.name_at_end ?? row.name_at_start)}</td>
            <td>
              {row.present_at_start ? "start" : ""}
              {row.present_at_start && row.present_at_end ? " + " : ""}
              {row.present_at_end ? "end" : ""}
            </td>
            <td>{display(row.side_at_end ?? row.side_at_start)}</td>
            <td>{display(row.group_at_end ?? row.group_at_start)}</td>
            <td>{display(row.role_at_end ?? row.role_at_start)}</td>
            <td>
              {row.stats ? `${row.stats.ai_kills + row.stats.infantry_kills + row.stats.vehicle_kills}/${row.stats.deaths}` : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
