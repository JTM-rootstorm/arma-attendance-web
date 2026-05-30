import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiClientError, apiFetch, fetchCsv } from "./api";
import {
  canDeleteOperations,
  canExport,
  canOpenBattalion,
  canOpenComms,
  canOpenDashboard,
  canOpenIdentityAdmin,
  canOpenLeaderboard,
  canOpenOperations,
  canOpenRoster,
  canManageMachineTokens,
  canResetPlayerNames,
  canSeeSensitiveIds,
  canViewSignalDetail,
  isOwner
} from "./authz";
import { CommandShell } from "./components/CommandShell";
import { PayloadInspector } from "./components/PayloadInspector";
import { StatusChip } from "./components/StatusChip";
import { emptyResult, resultError, statusLabel } from "./format";
import { DashboardPage } from "./pages/DashboardPage";
import { BattalionPage } from "./pages/BattalionPage";
import { DiscordPage } from "./pages/DiscordPage";
import { IdentityPage } from "./pages/IdentityPage";
import { LeaderboardPage } from "./pages/LeaderboardPage";
import { MyStatsPage } from "./pages/MyStatsPage";
import { OperationsPage } from "./pages/OperationsPage";
import { PlayersPage } from "./pages/PlayersPage";
import { SystemPage } from "./pages/SystemPage";
import type {
  AdminUsersResponse,
  ApiResult,
  CreateMachineTokenResponse,
  DashboardSummaryResponse,
  DataQualityResponse,
  DbHealthResponse,
  HealthResponse,
  MachineTokensResponse,
  MachineTokenKind,
  MeResponse,
  MyOperationsResponse,
  MyPlayerResponse,
  OperationAttendanceResponse,
  OperationDetailResponse,
  OperationsResponse,
  OperationSummaryResponse,
  PlayerDetailResponse,
  PlayersResponse,
  PlayerSummaryResponse,
  ViewName
} from "./types";

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
  const [view, setView] = useState<ViewName>("me");
  const [health, setHealth] = useState<ApiResult<HealthResponse>>(emptyResult);
  const [dbHealth, setDbHealth] = useState<ApiResult<DbHealthResponse>>(emptyResult);
  const [me, setMe] = useState<ApiResult<MeResponse>>(emptyResult);
  const [adminUsers, setAdminUsers] = useState<ApiResult<AdminUsersResponse>>(emptyResult);
  const [machineTokens, setMachineTokens] = useState<ApiResult<MachineTokensResponse>>(emptyResult);
  const [createdMachineToken, setCreatedMachineToken] = useState<CreateMachineTokenResponse | null>(null);
  const [myPlayer, setMyPlayer] = useState<ApiResult<MyPlayerResponse>>(emptyResult);
  const [myOperations, setMyOperations] = useState<ApiResult<MyOperationsResponse>>(emptyResult);
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

  const sessionUser = me.status === "ready" ? me.data.user : null;
  const canAdmin = canOpenIdentityAdmin(sessionUser);
  const canManageSystem = canManageMachineTokens(sessionUser);
  const canViewDashboard = canOpenDashboard(sessionUser);
  const canViewBattalion = canOpenBattalion(sessionUser);
  const canViewLeaderboard = canOpenLeaderboard(sessionUser);
  const canViewOperations = canOpenOperations(sessionUser);
  const canViewRoster = canOpenRoster(sessionUser);
  const canViewComms = canOpenComms(sessionUser);
  const canExportViews = canExport(sessionUser);
  const canResetRosterNames = canResetPlayerNames(sessionUser);
  const canDeleteOperationRows = canDeleteOperations(sessionUser);
  const canInspectSignals = canViewSignalDetail(sessionUser);

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
    if (!isOwner(sessionUser)) {
      setDbHealth(emptyResult);
      return;
    }

    setDbHealth({ status: "loading", data: null, error: null });

    try {
      setDbHealth({
        status: "ready",
        data: await apiFetch<DbHealthResponse>("/health/db"),
        error: null
      });
    } catch (error) {
      setDbHealth(errorResult(error, "DB health failed."));
    }
  }, [sessionUser]);

  const loadMe = useCallback(async () => {
    setMe({ status: "loading", data: null, error: null });

    try {
      setMe({ status: "ready", data: await apiFetch<MeResponse>("/v1/me"), error: null });
    } catch (error) {
      const parsed = resultError(error, "No active session.");
      if (parsed.code === "unauthorized") {
        setMe(emptyResult);
      } else {
        setMe(errorResult(error, "Session check failed."));
      }
    }
  }, []);

  const loadAdminUsers = useCallback(async () => {
    if (!canAdmin) {
      setAdminUsers(emptyResult);
      return;
    }

    setAdminUsers({ status: "loading", data: null, error: null });

    try {
      setAdminUsers({
        status: "ready",
        data: await apiFetch<AdminUsersResponse>("/v1/admin/users"),
        error: null
      });
    } catch (error) {
      setAdminUsers(errorResult(error, "Admin users failed."));
    }
  }, [canAdmin]);

  const loadMachineTokens = useCallback(async () => {
    if (!canManageSystem) {
      setMachineTokens(emptyResult);
      setCreatedMachineToken(null);
      return;
    }

    setMachineTokens({ status: "loading", data: null, error: null });

    try {
      setMachineTokens({
        status: "ready",
        data: await apiFetch<MachineTokensResponse>("/v1/system/machine-tokens"),
        error: null
      });
    } catch (error) {
      setMachineTokens(errorResult(error, "Machine tokens failed."));
    }
  }, [canManageSystem]);

  const loadMyStats = useCallback(async () => {
    if (!sessionUser) {
      setMyPlayer(emptyResult);
      setMyOperations(emptyResult);
      return;
    }

    setMyPlayer({ status: "loading", data: null, error: null });
    setMyOperations({ status: "loading", data: null, error: null });

    try {
      const [player, operationsData] = await Promise.all([
        apiFetch<MyPlayerResponse>("/v1/me/player"),
        apiFetch<MyOperationsResponse>("/v1/me/operations")
      ]);
      setMyPlayer({ status: "ready", data: player, error: null });
      setMyOperations({ status: "ready", data: operationsData, error: null });
    } catch (error) {
      setMyPlayer(errorResult(error, "My stats failed."));
      setMyOperations(errorResult(error, "My operations failed."));
    }
  }, [sessionUser]);

  const loadSummary = useCallback(async () => {
    if (!canViewDashboard) {
      setSummary(emptyResult);
      return;
    }

    setSummary({ status: "loading", data: null, error: null });

    try {
      setSummary({
        status: "ready",
        data: await apiFetch<DashboardSummaryResponse>("/v1/dashboard/summary"),
        error: null
      });
    } catch (error) {
      setSummary(errorResult(error, "Summary failed."));
    }
  }, [canViewDashboard]);

  const loadDataQuality = useCallback(async () => {
    if (!canSeeSensitiveIds(sessionUser)) {
      setDataQuality(emptyResult);
      return;
    }

    setDataQuality({ status: "loading", data: null, error: null });

    try {
      setDataQuality({
        status: "ready",
        data: await apiFetch<DataQualityResponse>("/v1/data-quality"),
        error: null
      });
    } catch (error) {
      setDataQuality(errorResult(error, "Data quality checks failed."));
    }
  }, [sessionUser]);

  const loadOperations = useCallback(async () => {
    if (!canViewOperations) {
      setOperations(emptyResult);
      return;
    }

    setOperations({ status: "loading", data: null, error: null });

    try {
      setOperations({
        status: "ready",
        data: await apiFetch<OperationsResponse>("/v1/operations", {
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
  }, [canViewOperations, operationFilters]);

  const loadPlayers = useCallback(async () => {
    if (!canViewRoster) {
      setPlayers(emptyResult);
      return;
    }

    setPlayers({ status: "loading", data: null, error: null });

    try {
      setPlayers({
        status: "ready",
        data: await apiFetch<PlayersResponse>("/v1/players", {
          params: { q: playerSearch, limit: "50" }
        }),
        error: null
      });
    } catch (error) {
      setPlayers(errorResult(error, "Players failed."));
    }
  }, [canViewRoster, playerSearch]);

  const loadOperationDetail = useCallback(
    async (operationId: string) => {
      if (!canViewOperations || operationId.length === 0) {
        return;
      }

      setOperationDetail({ status: "loading", data: null, error: null });
      setOperationSummary({ status: "loading", data: null, error: null });
      setOperationAttendance({ status: "loading", data: null, error: null });

      try {
        const [detail, detailSummary, attendance] = await Promise.all([
          apiFetch<OperationDetailResponse>(`/v1/operations/${operationId}`),
          apiFetch<OperationSummaryResponse>(`/v1/operations/${operationId}/summary`),
          apiFetch<OperationAttendanceResponse>(`/v1/operations/${operationId}/attendance`)
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
    [canViewOperations]
  );

  const loadPlayerDetail = useCallback(
    async (playerUid: string) => {
      if (!canViewRoster || playerUid.length === 0) {
        return;
      }

      setPlayerDetail({ status: "loading", data: null, error: null });
      setPlayerSummary({ status: "loading", data: null, error: null });

      try {
        const encodedUid = encodeURIComponent(playerUid);
        const [detail, detailSummary] = await Promise.all([
          apiFetch<PlayerDetailResponse>(`/v1/players/${encodedUid}`),
          apiFetch<PlayerSummaryResponse>(`/v1/players/${encodedUid}/summary`)
        ]);

        setPlayerDetail({ status: "ready", data: detail, error: null });
        setPlayerSummary({ status: "ready", data: detailSummary, error: null });
      } catch (error) {
        setPlayerDetail(errorResult(error, "Player detail failed."));
        setPlayerSummary(errorResult(error, "Player summary failed."));
      }
    },
    [canViewRoster]
  );

  useEffect(() => {
    void loadHealth();
    void loadMe();
  }, [loadHealth, loadMe]);

  useEffect(() => {
    void loadDbHealth();
    void loadSummary();
    void loadDataQuality();
    void loadOperations();
    void loadPlayers();
  }, [loadDataQuality, loadDbHealth, loadOperations, loadPlayers, loadSummary]);

  useEffect(() => {
    void loadAdminUsers();
  }, [loadAdminUsers]);

  useEffect(() => {
    void loadMachineTokens();
  }, [loadMachineTokens]);

  useEffect(() => {
    void loadMyStats();
  }, [loadMyStats]);

  useEffect(() => {
    if (!sessionUser) {
      return;
    }

    const allowed =
      view === "me" ||
      (view === "battalion" && canViewBattalion) ||
      (view === "leaderboard" && canViewLeaderboard) ||
      (view === "dashboard" && canViewDashboard) ||
      (view === "operations" && canViewOperations) ||
      (view === "players" && canViewRoster) ||
      (view === "discord" && canViewComms) ||
      (view === "admin" && canAdmin) ||
      (view === "system" && canManageSystem);

    if (!allowed) {
      setView("me");
    }
  }, [
    canAdmin,
    canManageSystem,
    canViewBattalion,
    canViewComms,
    canViewDashboard,
    canViewLeaderboard,
    canViewOperations,
    canViewRoster,
    sessionUser,
    view
  ]);

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

  async function logout() {
    try {
      await apiFetch("/auth/logout", { method: "POST" });
    } catch {
      // Clearing local session state is still useful if the server session is gone.
    }

    setMe(emptyResult);
    setAdminUsers(emptyResult);
    setMachineTokens(emptyResult);
    setView("me");
  }

  function loginDiscord() {
    window.location.href = `/auth/discord/start?redirect_after=${encodeURIComponent(window.location.pathname)}`;
  }

  async function loginTestOwner() {
    await apiFetch("/auth/test/login", {
      method: "POST",
      body: {
        provider_user_id: "local-dev-owner",
        display_name: "Local Dev Owner",
        roles: ["owner"]
      }
    });
    await loadMe();
  }

  function selectOperation(operationId: string) {
    setSelectedOperationId(operationId);
    setView("operations");
  }

  async function exportCsv(path: string, filename: string) {
    if (!canExportViews) {
      setExportMessage("Export not available for this role.");
      return;
    }

    try {
      const csv = await fetchCsv(path);
      saveCsv(csv, filename);
      setExportMessage(`Export ready: ${filename}`);
    } catch (error) {
      const parsed = resultError(error, "Export failed.");
      setExportMessage(parsed.message);
    }
  }

  async function createMachineToken(input: { name: string; token_kind: MachineTokenKind }) {
    const created = await apiFetch<CreateMachineTokenResponse>("/v1/system/machine-tokens", {
      method: "POST",
      body: input
    });
    setCreatedMachineToken(created);
    await loadMachineTokens();
  }

  async function revokeMachineToken(tokenId: string) {
    await apiFetch(`/v1/system/machine-tokens/${tokenId}`, { method: "DELETE" });
    await loadMachineTokens();
  }

  async function updatePlayerName(displayName: string) {
    await apiFetch<MyPlayerResponse>("/v1/me/player", {
      method: "PATCH",
      body: { display_name: displayName }
    });
    await loadMyStats();
    await loadPlayers();
  }

  async function resetPlayerName(playerUid: string) {
    await apiFetch(`/v1/admin/players/${encodeURIComponent(playerUid)}/reset-name`, { method: "POST" });
    await loadPlayers();
    await loadPlayerDetail(playerUid);
  }

  async function deleteOperation(operationId: string) {
    try {
      await apiFetch(`/v1/operations/${encodeURIComponent(operationId)}`, { method: "DELETE" });
    } catch (error) {
      if (!(error instanceof ApiClientError) || error.code !== "operation_not_found") {
        throw error;
      }
    }

    setSelectedOperationId("");
    setOperationDetail(emptyResult);
    setOperationSummary(emptyResult);
    setOperationAttendance(emptyResult);
    await loadOperations();
  }

  async function refreshRoster() {
    await loadPlayers();

    if (selectedPlayerUid.length > 0) {
      await loadPlayerDetail(selectedPlayerUid);
    }
  }

  const content =
    view === "me" && sessionUser ? (
      <MyStatsPage
        user={sessionUser}
        myPlayer={myPlayer}
        myOperations={myOperations}
        onRefresh={() => void loadMyStats()}
        onUpdatePlayerName={updatePlayerName}
        onLinkSteam={() => {
          window.location.href = `/auth/steam/start?redirect_after=${encodeURIComponent(window.location.pathname)}`;
        }}
        onUnlinkSteam={async () => {
          await apiFetch("/v1/me/identities/steam", { method: "DELETE" });
          await loadMe();
          await loadMyStats();
        }}
      />
    ) : view === "battalion" && canViewBattalion && sessionUser ? (
      <BattalionPage user={sessionUser} />
    ) : view === "leaderboard" && canViewLeaderboard ? (
      <LeaderboardPage />
    ) : view === "dashboard" && canViewDashboard ? (
      <DashboardPage
        hasToken={canViewDashboard}
        summary={summary}
        dataQuality={dataQuality}
        onSelectOperation={selectOperation}
        onOpenOperations={() => setView("operations")}
        onOpenPlayers={() => setView("players")}
        canExport={canExportViews}
        onExportPlayers={() => void exportCsv(`/v1/players.csv?q=${encodeURIComponent(playerSearch)}`, "players.csv")}
      />
    ) : view === "operations" && canViewOperations ? (
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
        canExport={canExportViews}
        canDeleteOperations={canDeleteOperationRows}
        onDeleteOperation={deleteOperation}
        onExportAttendance={(operationId) => void exportCsv(`/v1/operations/${operationId}/attendance.csv`, `operation-${operationId}-attendance.csv`)}
      />
    ) : view === "players" && canViewRoster ? (
      <PlayersPage
        players={players}
        playerDetail={playerDetail}
        playerSummary={playerSummary}
        playerSearch={playerSearch}
        selectedPlayerUid={selectedPlayerUid}
        onSearchChange={setPlayerSearch}
        onSearch={() => void loadPlayers()}
        onRefresh={() => void refreshRoster()}
        onSelectPlayer={setSelectedPlayerUid}
        canExport={canExportViews}
        canResetPlayerNames={canResetRosterNames}
        onResetPlayerName={resetPlayerName}
        onExportPlayers={() => void exportCsv(`/v1/players.csv?q=${encodeURIComponent(playerSearch)}`, "players.csv")}
      />
    ) : view === "discord" && canViewComms ? (
      <DiscordPage hasToken={Boolean(sessionUser)} token="" />
    ) : view === "admin" && canAdmin ? (
      <IdentityPage
        me={me}
        adminUsers={adminUsers}
        onLoginDiscord={loginDiscord}
        onLogout={() => void logout()}
        onRefreshMe={() => void loadMe()}
        onRefreshAdminUsers={() => void loadAdminUsers()}
      />
    ) : view === "system" && canManageSystem ? (
      <SystemPage
        machineTokens={machineTokens}
        createdToken={createdMachineToken}
        onCreateToken={createMachineToken}
        onRevokeToken={revokeMachineToken}
        onRefresh={() => void loadMachineTokens()}
      />
    ) : sessionUser ? (
      <MyStatsPage
        user={sessionUser}
        myPlayer={myPlayer}
        myOperations={myOperations}
        onRefresh={() => void loadMyStats()}
        onUpdatePlayerName={updatePlayerName}
        onLinkSteam={() => {
          window.location.href = `/auth/steam/start?redirect_after=${encodeURIComponent(window.location.pathname)}`;
        }}
        onUnlinkSteam={async () => {
          await apiFetch("/v1/me/identities/steam", { method: "DELETE" });
          await loadMe();
          await loadMyStats();
        }}
      />
    ) : null;

  if (!sessionUser) {
    return (
      <main className="login-only">
        <section className="login-panel">
          <p className="console-glyphs" aria-hidden="true">
            authentication required
          </p>
          <p className="eyebrow">Arma Attendance Tracker</p>
          <h1>Login Required</h1>
          <p>Use Discord to open your attendance console.</p>
          <button type="button" onClick={loginDiscord}>
            Login with Discord
          </button>
          {import.meta.env.DEV ? (
            <button type="button" className="secondary" onClick={() => void loginTestOwner()}>
              Enter Test Console
            </button>
          ) : null}
          <StatusChip label={`API ${statusLabel(health)}`} tone={health.status === "error" ? "danger" : health.status === "ready" ? "ready" : "muted"} />
        </section>
      </main>
    );
  }

  return (
    <CommandShell
      view={view}
      health={health}
      dbHealth={dbHealth}
      sessionUser={sessionUser}
      onViewChange={setView}
      onLogout={() => void logout()}
      inspector={
        canInspectSignals ? (
          <PayloadInspector operationDetail={selectedOperationDetail} playerDetail={selectedPlayerDetail} exportMessage={exportMessage} />
        ) : null
      }
    >
      {content}
    </CommandShell>
  );
}
