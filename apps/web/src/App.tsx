import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch, fetchCsv } from "./api";
import { CommandShell } from "./components/CommandShell";
import { PayloadInspector } from "./components/PayloadInspector";
import { emptyResult, resultError } from "./format";
import { DashboardPage } from "./pages/DashboardPage";
import { OperationsPage } from "./pages/OperationsPage";
import { PlayersPage } from "./pages/PlayersPage";
import type {
  ApiResult,
  DashboardSummaryResponse,
  DataQualityResponse,
  DbHealthResponse,
  HealthResponse,
  OperationAttendanceResponse,
  OperationDetailResponse,
  OperationsResponse,
  OperationSummaryResponse,
  PlayerDetailResponse,
  PlayersResponse,
  PlayerSummaryResponse,
  ViewName
} from "./types";

const tokenStorageKey = "arma-attendance-api-token";

function getStoredToken(): string {
  return window.sessionStorage.getItem(tokenStorageKey) ?? "";
}

function errorResult<T>(error: unknown, fallback: string): ApiResult<T> {
  const parsed = resultError(error, fallback);

  return {
    status: "error",
    data: null,
    error: parsed.message,
    ...(parsed.code ? { errorCode: parsed.code } : {})
  };
}

function saveCsv(text: string, filename: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function App() {
  const [token, setToken] = useState(getStoredToken);
  const [tokenDraft, setTokenDraft] = useState(token);
  const [view, setView] = useState<ViewName>("dashboard");
  const [health, setHealth] = useState<ApiResult<HealthResponse>>(emptyResult);
  const [dbHealth, setDbHealth] = useState<ApiResult<DbHealthResponse>>(emptyResult);
  const [summary, setSummary] = useState<ApiResult<DashboardSummaryResponse>>(emptyResult);
  const [dataQuality, setDataQuality] = useState<ApiResult<DataQualityResponse>>(emptyResult);
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

  const selectedOperationDetail = useMemo(
    () => (operationDetail.status === "ready" ? operationDetail.data : null),
    [operationDetail]
  );

  const selectedPlayerDetail = useMemo(() => (playerDetail.status === "ready" ? playerDetail.data : null), [playerDetail]);

  const loadHealth = useCallback(async () => {
    setHealth({ status: "loading", data: null, error: null });

    try {
      setHealth({ status: "ready", data: await apiFetch<HealthResponse>("/health"), error: null });
    } catch (error) {
      setHealth(errorResult(error, "Health check failed."));
    }
  }, []);

  const loadDbHealth = useCallback(async () => {
    if (!hasToken) {
      setDbHealth(emptyResult);
      return;
    }

    setDbHealth({ status: "loading", data: null, error: null });

    try {
      setDbHealth({ status: "ready", data: await apiFetch<DbHealthResponse>("/health/db", { token }), error: null });
    } catch (error) {
      setDbHealth(errorResult(error, "DB health failed."));
    }
  }, [hasToken, token]);

  const loadSummary = useCallback(async () => {
    if (!hasToken) {
      setSummary(emptyResult);
      return;
    }

    setSummary({ status: "loading", data: null, error: null });

    try {
      setSummary({
        status: "ready",
        data: await apiFetch<DashboardSummaryResponse>("/v1/dashboard/summary", { token }),
        error: null
      });
    } catch (error) {
      setSummary(errorResult(error, "Summary failed."));
    }
  }, [hasToken, token]);

  const loadDataQuality = useCallback(async () => {
    if (!hasToken) {
      setDataQuality(emptyResult);
      return;
    }

    setDataQuality({ status: "loading", data: null, error: null });

    try {
      setDataQuality({
        status: "ready",
        data: await apiFetch<DataQualityResponse>("/v1/data-quality", { token }),
        error: null
      });
    } catch (error) {
      setDataQuality(errorResult(error, "Data quality checks failed."));
    }
  }, [hasToken, token]);

  const loadOperations = useCallback(async () => {
    if (!hasToken) {
      setOperations(emptyResult);
      return;
    }

    setOperations({ status: "loading", data: null, error: null });

    try {
      setOperations({
        status: "ready",
        data: await apiFetch<OperationsResponse>("/v1/operations", {
          token,
          params: {
            ...operationFilters,
            limit: "50"
          }
        }),
        error: null
      });
    } catch (error) {
      setOperations(errorResult(error, "Operations failed."));
    }
  }, [hasToken, operationFilters, token]);

  const loadPlayers = useCallback(async () => {
    if (!hasToken) {
      setPlayers(emptyResult);
      return;
    }

    setPlayers({ status: "loading", data: null, error: null });

    try {
      setPlayers({
        status: "ready",
        data: await apiFetch<PlayersResponse>("/v1/players", {
          token,
          params: { q: playerSearch, limit: "50" }
        }),
        error: null
      });
    } catch (error) {
      setPlayers(errorResult(error, "Players failed."));
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
          apiFetch<OperationDetailResponse>(`/v1/operations/${operationId}`, { token }),
          apiFetch<OperationSummaryResponse>(`/v1/operations/${operationId}/summary`, { token }),
          apiFetch<OperationAttendanceResponse>(`/v1/operations/${operationId}/attendance`, { token })
        ]);

        setOperationDetail({ status: "ready", data: detail, error: null });
        setOperationSummary({ status: "ready", data: detailSummary, error: null });
        setOperationAttendance({ status: "ready", data: attendance, error: null });
      } catch (error) {
        setOperationDetail(errorResult(error, "Operation detail failed."));
        setOperationSummary(errorResult(error, "Operation summary failed."));
        setOperationAttendance(errorResult(error, "Operation attendance failed."));
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
        const encodedUid = encodeURIComponent(playerUid);
        const [detail, detailSummary] = await Promise.all([
          apiFetch<PlayerDetailResponse>(`/v1/players/${encodedUid}`, { token }),
          apiFetch<PlayerSummaryResponse>(`/v1/players/${encodedUid}/summary`, { token })
        ]);

        setPlayerDetail({ status: "ready", data: detail, error: null });
        setPlayerSummary({ status: "ready", data: detailSummary, error: null });
      } catch (error) {
        setPlayerDetail(errorResult(error, "Player detail failed."));
        setPlayerSummary(errorResult(error, "Player summary failed."));
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
    void loadDataQuality();
    void loadOperations();
    void loadPlayers();
  }, [loadDataQuality, loadDbHealth, loadOperations, loadPlayers, loadSummary]);

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
    setDataQuality(emptyResult);
    setOperations(emptyResult);
    setPlayers(emptyResult);
    setOperationDetail(emptyResult);
    setOperationSummary(emptyResult);
    setOperationAttendance(emptyResult);
    setPlayerDetail(emptyResult);
    setPlayerSummary(emptyResult);
    setSelectedOperationId("");
    setSelectedPlayerUid("");
  }

  function selectOperation(operationId: string) {
    setSelectedOperationId(operationId);
    setView("operations");
  }

  async function exportCsv(path: string, filename: string) {
    if (!hasToken) {
      setExportMessage("Token required.");
      return;
    }

    try {
      const csv = await fetchCsv(path, token);
      saveCsv(csv, filename);
      setExportMessage(`Export ready: ${filename}`);
    } catch (error) {
      const parsed = resultError(error, "Export failed.");
      setExportMessage(parsed.message);
    }
  }

  const content =
    view === "dashboard" ? (
      <DashboardPage
        hasToken={hasToken}
        summary={summary}
        dataQuality={dataQuality}
        onSelectOperation={selectOperation}
        onOpenOperations={() => setView("operations")}
        onOpenPlayers={() => setView("players")}
        onExportPlayers={() => void exportCsv(`/v1/players.csv?q=${encodeURIComponent(playerSearch)}`, "players.csv")}
      />
    ) : view === "operations" ? (
      <OperationsPage
        operations={operations}
        operationDetail={operationDetail}
        operationSummary={operationSummary}
        operationAttendance={operationAttendance}
        selectedOperationId={selectedOperationId}
        operationFilters={operationFilters}
        onFiltersChange={setOperationFilters}
        onSelectOperation={setSelectedOperationId}
        onRefresh={() => void loadOperations()}
        onExportAttendance={(operationId) => void exportCsv(`/v1/operations/${operationId}/attendance.csv`, `operation-${operationId}-attendance.csv`)}
      />
    ) : (
      <PlayersPage
        players={players}
        playerDetail={playerDetail}
        playerSummary={playerSummary}
        playerSearch={playerSearch}
        selectedPlayerUid={selectedPlayerUid}
        onSearchChange={setPlayerSearch}
        onSearch={() => void loadPlayers()}
        onSelectPlayer={setSelectedPlayerUid}
        onExportPlayers={() => void exportCsv(`/v1/players.csv?q=${encodeURIComponent(playerSearch)}`, "players.csv")}
      />
    );

  return (
    <CommandShell
      view={view}
      health={health}
      dbHealth={dbHealth}
      hasToken={hasToken}
      tokenDraft={tokenDraft}
      onViewChange={setView}
      onTokenDraftChange={setTokenDraft}
      onTokenSave={saveToken}
      onTokenForget={forgetToken}
      inspector={<PayloadInspector operationDetail={selectedOperationDetail} playerDetail={selectedPlayerDetail} exportMessage={exportMessage} />}
    >
      {content}
    </CommandShell>
  );
}
