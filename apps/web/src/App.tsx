import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";

import { ApiClientError, apiFetch, fetchCsv } from "./api";
import {
  canDeleteOperations,
  canDeletePlayers,
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
import type {
  AdminUsersResponse,
  ApiResult,
  CreateMachineTokenResponse,
  DashboardSummaryResponse,
  DataQualityResponse,
  DbHealthResponse,
  DiscordRefreshStartResponse,
  HealthResponse,
  MachineTokenSecretResponse,
  MachineTokensResponse,
  MachineTokenKind,
  MeResponse,
  MyOperationsResponse,
  MyPlayerResponse,
  OperationAttendanceResponse,
  OperationDetailResponse,
  OperationsResponse,
  OperationSummaryResponse,
  PlanetResponse,
  PlanetsResponse,
  PlayerDetailResponse,
  PlayersResponse,
  PlayerSummaryResponse,
  RepresentedUnitResponse,
  ViewName,
  XpRewardTierResponse,
  XpRewardTiersResponse
} from "./types";

const adminUsersPageSize = 50;
const finishedOperationsPageSize = 50;
const autoRefreshMs = 60_000;

const BattalionPage = lazy(() => import("./pages/BattalionPage").then((module) => ({ default: module.BattalionPage })));
const DashboardPage = lazy(() => import("./pages/DashboardPage").then((module) => ({ default: module.DashboardPage })));
const DiscordPage = lazy(() => import("./pages/DiscordPage").then((module) => ({ default: module.DiscordPage })));
const IdentityPage = lazy(() => import("./pages/IdentityPage").then((module) => ({ default: module.IdentityPage })));
const LeaderboardPage = lazy(() => import("./pages/LeaderboardPage").then((module) => ({ default: module.LeaderboardPage })));
const MyStatsPage = lazy(() => import("./pages/MyStatsPage").then((module) => ({ default: module.MyStatsPage })));
const OperationsPage = lazy(() => import("./pages/OperationsPage").then((module) => ({ default: module.OperationsPage })));
const PlayersPage = lazy(() => import("./pages/PlayersPage").then((module) => ({ default: module.PlayersPage })));
const SystemPage = lazy(() => import("./pages/SystemPage").then((module) => ({ default: module.SystemPage })));

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
  const [adminUsersOffset, setAdminUsersOffset] = useState(0);
  const [machineTokens, setMachineTokens] = useState<ApiResult<MachineTokensResponse>>(emptyResult);
  const [createdMachineToken, setCreatedMachineToken] = useState<CreateMachineTokenResponse | null>(null);
  const [xpRewardTiers, setXpRewardTiers] = useState<ApiResult<XpRewardTiersResponse>>(emptyResult);
  const [planets, setPlanets] = useState<ApiResult<PlanetsResponse>>(emptyResult);
  const [myPlayer, setMyPlayer] = useState<ApiResult<MyPlayerResponse>>(emptyResult);
  const [myOperations, setMyOperations] = useState<ApiResult<MyOperationsResponse>>(emptyResult);
  const [summary, setSummary] = useState<ApiResult<DashboardSummaryResponse>>(emptyResult);
  const [dataQuality, setDataQuality] = useState<ApiResult<DataQualityResponse>>(emptyResult);
  const [operations, setOperations] = useState<ApiResult<OperationsResponse>>(emptyResult);
  const [finishedOperations, setFinishedOperations] = useState<ApiResult<OperationsResponse>>(emptyResult);
  const [finishedOperationsOffset, setFinishedOperationsOffset] = useState(0);
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
  const [discordRefreshNotice, setDiscordRefreshNotice] = useState<{ tone: "success" | "error"; message: string } | null>(null);

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
  const canDeleteRosterPlayers = canDeletePlayers(sessionUser);
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
        data: await apiFetch<AdminUsersResponse>("/v1/admin/users", {
          params: {
            limit: String(adminUsersPageSize),
            offset: String(adminUsersOffset)
          }
        }),
        error: null
      });
    } catch (error) {
      setAdminUsers(errorResult(error, "Admin users failed."));
    }
  }, [adminUsersOffset, canAdmin]);

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

  const loadXpRewardTiers = useCallback(async () => {
    if (!canManageSystem) {
      setXpRewardTiers(emptyResult);
      return;
    }

    setXpRewardTiers({ status: "loading", data: null, error: null });

    try {
      setXpRewardTiers({
        status: "ready",
        data: await apiFetch<XpRewardTiersResponse>("/v1/system/xp-reward-tiers", {
          params: { limit: "200" }
        }),
        error: null
      });
    } catch (error) {
      setXpRewardTiers(errorResult(error, "XP reward tiers failed."));
    }
  }, [canManageSystem]);

  const loadPlanets = useCallback(async () => {
    if (!canManageSystem) {
      setPlanets(emptyResult);
      return;
    }

    setPlanets({ status: "loading", data: null, error: null });

    try {
      setPlanets({
        status: "ready",
        data: await apiFetch<PlanetsResponse>("/v1/system/planets", {
          params: { include_inactive: "true", limit: "200" }
        }),
        error: null
      });
    } catch (error) {
      setPlanets(errorResult(error, "Planets failed."));
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

  const loadFinishedOperations = useCallback(async () => {
    if (!canViewOperations) {
      setFinishedOperations(emptyResult);
      return;
    }

    setFinishedOperations({ status: "loading", data: null, error: null });

    const { status, ...baseFilters } = operationFilters;
    if (status === "started") {
      setFinishedOperations({
        status: "ready",
        data: {
          ok: true,
          operations: [],
          pagination: {
            limit: finishedOperationsPageSize,
            offset: 0,
            count: 0
          }
        },
        error: null
      });
      return;
    }

    const finishedParams =
      status.length > 0
        ? {
            ...baseFilters,
            status,
            limit: String(finishedOperationsPageSize),
            offset: String(finishedOperationsOffset)
          }
        : {
            ...baseFilters,
            status_group: "finished",
            limit: String(finishedOperationsPageSize),
            offset: String(finishedOperationsOffset)
          };

    try {
      setFinishedOperations({
        status: "ready",
        data: await apiFetch<OperationsResponse>("/v1/operations", {
          params: finishedParams
        }),
        error: null
      });
    } catch (error) {
      setFinishedOperations(errorResult(error, "Finished operations failed."));
    }
  }, [canViewOperations, finishedOperationsOffset, operationFilters]);

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

  const updateOperationFilters = useCallback((filters: typeof operationFilters) => {
    setFinishedOperationsOffset(0);
    setOperationFilters(filters);
  }, []);

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
    const url = new URL(window.location.href);
    const refreshed = url.searchParams.get("discord_refreshed");
    const refreshError = url.searchParams.get("discord_refresh_error");

    if (!refreshed && !refreshError) {
      return;
    }

    if (refreshed === "1") {
      setDiscordRefreshNotice({ tone: "success", message: "Discord memberships refreshed." });
    } else {
      setDiscordRefreshNotice({ tone: "error", message: "Discord refresh failed. Try again in a moment." });
    }

    url.searchParams.delete("discord_refreshed");
    url.searchParams.delete("discord_refresh_error");
    window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
  }, []);

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
    void loadXpRewardTiers();
  }, [loadXpRewardTiers]);

  useEffect(() => {
    void loadPlanets();
  }, [loadPlanets]);

  useEffect(() => {
    void loadMyStats();
  }, [loadMyStats]);

  useEffect(() => {
    void loadFinishedOperations();
  }, [loadFinishedOperations]);

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

  useEffect(() => {
    if (!sessionUser) {
      return;
    }

    const interval = window.setInterval(() => {
      if (document.visibilityState === "hidden") {
        return;
      }

      if (view === "me") {
        void loadMyStats();
      } else if (view === "dashboard") {
        void loadSummary();
        void loadDataQuality();
      } else if (view === "operations") {
        void loadOperations();
        void loadFinishedOperations();
        if (selectedOperationId) {
          void loadOperationDetail(selectedOperationId);
        }
      } else if (view === "players") {
        void refreshRoster();
      } else if (view === "admin") {
        void loadAdminUsers();
      } else if (view === "system") {
        void loadXpRewardTiers();
        void loadPlanets();
      }
    }, autoRefreshMs);

    return () => window.clearInterval(interval);
  }, [
    loadAdminUsers,
    loadDataQuality,
    loadFinishedOperations,
    loadMyStats,
    loadOperationDetail,
    loadOperations,
    loadPlanets,
    loadSummary,
    loadXpRewardTiers,
    selectedOperationId,
    sessionUser,
    view
  ]);

  async function logout() {
    try {
      await apiFetch("/auth/logout", { method: "POST" });
    } catch {
      // Clearing local session state is still useful if the server session is gone.
    }

    setMe(emptyResult);
    setAdminUsers(emptyResult);
    setMachineTokens(emptyResult);
    setXpRewardTiers(emptyResult);
    setPlanets(emptyResult);
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

  async function revealMachineToken(tokenId: string) {
    return apiFetch<MachineTokenSecretResponse>(`/v1/system/machine-tokens/${tokenId}/secret`, { method: "POST" });
  }

  async function createXpRewardTier(input: {
    mission_name_match: string;
    xp_amount: number;
    planet_progress_percent?: string;
  }) {
    await apiFetch<XpRewardTierResponse>("/v1/system/xp-reward-tiers", {
      method: "POST",
      body: input
    });
    await loadXpRewardTiers();
  }

  async function updateXpRewardTier(
    tierId: string,
    input: {
      mission_name_match?: string;
      xp_amount?: number;
      planet_progress_percent?: string;
    }
  ) {
    await apiFetch<XpRewardTierResponse>(`/v1/system/xp-reward-tiers/${tierId}`, {
      method: "PATCH",
      body: input
    });
    await loadXpRewardTiers();
  }

  async function deleteXpRewardTier(tierId: string) {
    await apiFetch<XpRewardTierResponse>(`/v1/system/xp-reward-tiers/${tierId}`, {
      method: "DELETE"
    });
    await loadXpRewardTiers();
  }

  async function createPlanet(input: {
    slug: string;
    name: string;
    description?: string | null;
    completion_percent: string;
    display_order: number;
    is_active: boolean;
    world_name_matches?: string[];
  }) {
    await apiFetch<PlanetResponse>("/v1/system/planets", {
      method: "POST",
      body: input
    });
    await loadPlanets();
    await loadXpRewardTiers();
  }

  async function updatePlanet(
    planetId: string,
    input: {
      slug?: string;
      name?: string;
      description?: string | null;
      completion_percent?: string;
      display_order?: number;
      is_active?: boolean;
      world_name_matches?: string[];
    }
  ) {
    await apiFetch<PlanetResponse>(`/v1/system/planets/${planetId}`, {
      method: "PATCH",
      body: input
    });
    await loadPlanets();
    await loadXpRewardTiers();
  }

  async function deletePlanet(planetId: string) {
    await apiFetch<PlanetResponse>(`/v1/system/planets/${planetId}`, {
      method: "DELETE"
    });
    await loadPlanets();
    await loadXpRewardTiers();
  }

  async function updatePlayerName(displayName: string) {
    await apiFetch<MyPlayerResponse>("/v1/me/player", {
      method: "PATCH",
      body: { display_name: displayName }
    });
    await loadMyStats();
    await loadPlayers();
  }

  async function updateRepresentedUnit(unitId: string) {
    await apiFetch<RepresentedUnitResponse>("/v1/me/player/represented-unit", {
      method: "PATCH",
      body: { unit_id: unitId }
    });
    await loadMyStats();
    await loadPlayers();
  }

  async function startDiscordRefresh() {
    const response = await apiFetch<DiscordRefreshStartResponse>("/v1/me/discord/refresh", {
      method: "POST",
      body: { return_to: `${window.location.pathname}${window.location.search}${window.location.hash}` }
    });
    window.location.href = response.discord_refresh_url;
  }

  async function resetPlayerName(playerUid: string) {
    await apiFetch(`/v1/admin/players/${encodeURIComponent(playerUid)}/reset-name`, { method: "POST" });
    await loadPlayers();
    await loadPlayerDetail(playerUid);
  }

  async function deletePlayer(playerUid: string) {
    await apiFetch(`/v1/admin/players/${encodeURIComponent(playerUid)}`, { method: "DELETE" });
    setSelectedPlayerUid("");
    setPlayerDetail(emptyResult);
    setPlayerSummary(emptyResult);
    await loadMe();
    await loadPlayers();
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
        discordRefreshNotice={discordRefreshNotice}
        onUpdatePlayerName={updatePlayerName}
        onUpdateRepresentedUnit={updateRepresentedUnit}
        onRefreshDiscord={startDiscordRefresh}
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
        finishedOperations={finishedOperations}
        operationDetail={operationDetail}
        operationSummary={operationSummary}
        operationAttendance={operationAttendance}
        selectedOperationId={selectedOperationId}
        operationFilters={operationFilters}
        onFiltersChange={updateOperationFilters}
        onSelectOperation={setSelectedOperationId}
        onRefresh={() => {
          void loadOperations();
          void loadFinishedOperations();
        }}
        onFinishedPageChange={setFinishedOperationsOffset}
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
        canDeletePlayers={canDeleteRosterPlayers}
        onResetPlayerName={resetPlayerName}
        onDeletePlayer={deletePlayer}
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
        onAdminUsersPageChange={(offset) => setAdminUsersOffset(offset)}
      />
    ) : view === "system" && canManageSystem ? (
      <SystemPage
        machineTokens={machineTokens}
        createdToken={createdMachineToken}
        onCreateToken={createMachineToken}
        onRevokeToken={revokeMachineToken}
        onRevealToken={revealMachineToken}
        onRefresh={() => void loadMachineTokens()}
        xpRewardTiers={xpRewardTiers}
        planets={planets}
        onRefreshXpRewardTiers={() => void loadXpRewardTiers()}
        onCreateXpRewardTier={createXpRewardTier}
        onUpdateXpRewardTier={updateXpRewardTier}
        onDeleteXpRewardTier={deleteXpRewardTier}
        onRefreshPlanets={loadPlanets}
        onCreatePlanet={createPlanet}
        onUpdatePlanet={updatePlanet}
        onDeletePlanet={deletePlanet}
      />
    ) : sessionUser ? (
      <MyStatsPage
        user={sessionUser}
        myPlayer={myPlayer}
        myOperations={myOperations}
        onRefresh={() => void loadMyStats()}
        discordRefreshNotice={discordRefreshNotice}
        onUpdatePlayerName={updatePlayerName}
        onUpdateRepresentedUnit={updateRepresentedUnit}
        onRefreshDiscord={startDiscordRefresh}
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
      <Suspense
        fallback={
          <section className="command-panel">
            <p className="empty-copy">Loading console...</p>
          </section>
        }
      >
        {content}
      </Suspense>
    </CommandShell>
  );
}
