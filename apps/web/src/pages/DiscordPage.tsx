import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch } from "../api";
import { CommandPanel } from "../components/CommandPanel";
import { MetricTile } from "../components/MetricTile";
import { StatusChip } from "../components/StatusChip";
import { TacticalTable } from "../components/TacticalTable";
import { displayValue, formatDate, resultError } from "../format";
import type {
  ApiResult,
  DiscordAssignmentAuditsResponse,
  DiscordAuthPolicyResponse,
  DiscordAuditsResponse,
  DiscordGuild,
  DiscordGuildsResponse,
  DiscordPlayerLinksResponse,
  DiscordReconcileResponse,
  DiscordRoleClaim,
  DiscordRoleMappingsResponse,
  DiscordRolesResponse,
  UnitsResponse
} from "../types";

const emptyResult: ApiResult<never> = { status: "idle", data: null, error: null };

const commsTabs = [
  { id: "guilds", label: "Guilds" },
  { id: "unit-mapping", label: "Unit Mapping" },
  { id: "players", label: "Player Links" },
  { id: "sync", label: "Sync" },
  { id: "audit", label: "Audit" }
] as const;

type CommsTab = (typeof commsTabs)[number]["id"];

type DiscordRoleAttachResponse = {
  ok: true;
  mapping: unknown | null;
  linked_unit_count: number;
};

function errorResult<T>(error: unknown, fallback: string): ApiResult<T> {
  const parsed = resultError(error, fallback);

  return {
    status: "error",
    data: null,
    error: parsed.message,
    ...(parsed.code ? { errorCode: parsed.code } : {})
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

function selectedGuildFrom(guilds: DiscordGuild[], guildId: string): DiscordGuild | null {
  return guilds.find((guild) => guild.guild_id === guildId) ?? guilds[0] ?? null;
}

export function DiscordPage({ hasToken, token }: { hasToken: boolean; token: string }) {
  const [activeTab, setActiveTab] = useState<CommsTab>("guilds");
  const [guilds, setGuilds] = useState<ApiResult<DiscordGuildsResponse>>(emptyResult);
  const [authPolicy, setAuthPolicy] = useState<ApiResult<DiscordAuthPolicyResponse>>(emptyResult);
  const [roles, setRoles] = useState<ApiResult<DiscordRolesResponse>>(emptyResult);
  const [links, setLinks] = useState<ApiResult<DiscordPlayerLinksResponse>>(emptyResult);
  const [mappings, setMappings] = useState<ApiResult<DiscordRoleMappingsResponse>>(emptyResult);
  const [reconcile, setReconcile] = useState<ApiResult<DiscordReconcileResponse>>(emptyResult);
  const [assignmentAudits, setAssignmentAudits] = useState<ApiResult<DiscordAssignmentAuditsResponse>>(emptyResult);
  const [audits, setAudits] = useState<ApiResult<DiscordAuditsResponse>>(emptyResult);
  const [units, setUnits] = useState<ApiResult<UnitsResponse>>(emptyResult);
  const [selectedGuildId, setSelectedGuildId] = useState("");
  const [roleDraft, setRoleDraft] = useState({ role_id: "", name: "", unit_id: "", priority: "0" });
  const [linkDraft, setLinkDraft] = useState({ player_uid: "", discord_user_id: "", discord_display_name: "" });
  const [reconcileDraft, setReconcileDraft] = useState({ discord_user_id: "", user_id: "" });
  const [message, setMessage] = useState("");

  const guildData = guilds.status === "ready" ? guilds.data.guilds : [];
  const authPolicyGuilds = authPolicy.status === "ready" ? authPolicy.data.guilds : [];
  const roleData = roles.status === "ready" ? roles.data.roles : [];
  const activeRoleData = roleData.filter((role) => !role.is_deleted);
  const linkData = links.status === "ready" ? links.data.links : [];
  const mappingData = mappings.status === "ready" ? mappings.data.mappings : [];
  const unitMappingData = mappingData.filter((mapping) => mapping.mapping_type === "unit_primary");
  const assignmentAuditData = assignmentAudits.status === "ready" ? assignmentAudits.data.audits : [];
  const auditData = audits.status === "ready" ? audits.data.audits : [];
  const unitData = units.status === "ready" ? units.data.units : [];
  const mappedRoleIds = new Set(unitMappingData.map((mapping) => mapping.role_id));
  const unitMappingRows = [
    ...unitMappingData.map((mapping) => {
      const role = activeRoleData.find((item) => item.role_id === mapping.role_id);
      return {
        key: mapping.id,
        role_id: mapping.role_id,
        friendly_name: role?.name ?? mapping.role_name ?? mapping.role_id,
        linked_unit: mapping.unit_name ?? mapping.unit_id,
        priority: String(mapping.priority)
      };
    }),
    ...activeRoleData
      .filter((role) => !mappedRoleIds.has(role.role_id))
      .map((role) => ({
        key: role.role_id,
        role_id: role.role_id,
        friendly_name: role.name,
        linked_unit: null,
        priority: "n/a"
      }))
  ];
  const selectedGuild = useMemo(() => selectedGuildFrom(guildData, selectedGuildId), [guildData, selectedGuildId]);

  const loadGuilds = useCallback(async () => {
    if (!hasToken) {
      setGuilds(emptyResult);
      setAuthPolicy(emptyResult);
      return;
    }

    setGuilds({ status: "loading", data: null, error: null });
    setAuthPolicy({ status: "loading", data: null, error: null });

    try {
      const [data, policy] = await Promise.all([
        apiFetch<DiscordGuildsResponse>("/v1/discord/guilds", { token }),
        apiFetch<DiscordAuthPolicyResponse>("/v1/discord/auth-policy", { token })
      ]);
      setGuilds({ status: "ready", data, error: null });
      setAuthPolicy({ status: "ready", data: policy, error: null });
      setSelectedGuildId((current) => current || data.guilds[0]?.guild_id || "");
    } catch (error) {
      setGuilds(errorResult(error, "Discord guilds failed."));
      setAuthPolicy(errorResult(error, "Discord auth policy failed."));
    }
  }, [hasToken, token]);

  const loadGuildDetail = useCallback(
    async (guildId: string) => {
      if (!hasToken || guildId.length === 0) {
        setRoles(emptyResult);
        setMappings(emptyResult);
        setAudits(emptyResult);
        setAssignmentAudits(emptyResult);
        return;
      }

      setRoles({ status: "loading", data: null, error: null });
      setMappings({ status: "loading", data: null, error: null });
      setAudits({ status: "loading", data: null, error: null });
      setAssignmentAudits({ status: "loading", data: null, error: null });

      try {
        const [nextRoles, nextMappings, nextAudits, nextAssignmentAudits] = await Promise.all([
          apiFetch<DiscordRolesResponse>(`/v1/discord/guilds/${encodeURIComponent(guildId)}/roles`, { token }),
          apiFetch<DiscordRoleMappingsResponse>(`/v1/discord/guilds/${encodeURIComponent(guildId)}/role-mappings`, { token }),
          apiFetch<DiscordAuditsResponse>(`/v1/discord/guilds/${encodeURIComponent(guildId)}/role-action-audits`, { token }),
          apiFetch<DiscordAssignmentAuditsResponse>("/v1/discord/assignment-audits", { token })
        ]);

        setRoles({ status: "ready", data: nextRoles, error: null });
        setMappings({ status: "ready", data: nextMappings, error: null });
        setAudits({ status: "ready", data: nextAudits, error: null });
        setAssignmentAudits({ status: "ready", data: nextAssignmentAudits, error: null });
      } catch (error) {
        setRoles(errorResult(error, "Discord roles failed."));
        setMappings(errorResult(error, "Discord role mappings failed."));
        setAudits(errorResult(error, "Discord audits failed."));
        setAssignmentAudits(errorResult(error, "Discord assignment audits failed."));
      }
    },
    [hasToken, token]
  );

  const loadLinks = useCallback(async () => {
    if (!hasToken) {
      setLinks(emptyResult);
      return;
    }

    setLinks({ status: "loading", data: null, error: null });

    try {
      setLinks({
        status: "ready",
        data: await apiFetch<DiscordPlayerLinksResponse>("/v1/discord/player-links", { token }),
        error: null
      });
    } catch (error) {
      setLinks(errorResult(error, "Discord player links failed."));
    }
  }, [hasToken, token]);

  const loadUnits = useCallback(async () => {
    if (!hasToken) {
      setUnits(emptyResult);
      return;
    }

    setUnits({ status: "loading", data: null, error: null });

    try {
      setUnits({
        status: "ready",
        data: await apiFetch<UnitsResponse>("/v1/units", { token, params: { include_inactive: "true", limit: "200" } }),
        error: null
      });
    } catch (error) {
      setUnits(errorResult(error, "Battalions failed."));
    }
  }, [hasToken, token]);

  useEffect(() => {
    void loadGuilds();
    void loadLinks();
    void loadUnits();
  }, [loadGuilds, loadLinks, loadUnits]);

  useEffect(() => {
    void loadGuildDetail(selectedGuild?.guild_id ?? "");
  }, [loadGuildDetail, selectedGuild?.guild_id]);

  async function createRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!hasToken || !selectedGuild) {
      setMessage("Guild selection required.");
      return;
    }

    try {
      const response = await apiFetch<DiscordRoleAttachResponse>(`/v1/discord/guilds/${encodeURIComponent(selectedGuild.guild_id)}/roles`, {
        method: "POST",
        token,
        body: {
          role_id: roleDraft.role_id,
          name: roleDraft.name,
          unit_id: roleDraft.unit_id,
          priority: Number(roleDraft.priority || 0),
          assignable: true
        }
      });
      setMessage(response.mapping ? "Discord role attached and unit mapping updated." : "Discord role attached.");
      setRoleDraft({ role_id: "", name: "", unit_id: "", priority: "0" });
      void loadGuildDetail(selectedGuild.guild_id);
    } catch (error) {
      setMessage(resultError(error, "Discord role attach failed.").message);
    }
  }

  async function createLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!hasToken) {
      setMessage("Token required.");
      return;
    }

    try {
      await apiFetch("/v1/discord/player-links", {
        method: "POST",
        token,
        body: {
          player_uid: linkDraft.player_uid,
          discord_user_id: linkDraft.discord_user_id,
          discord_display_name: linkDraft.discord_display_name || undefined,
          source: "manual",
          verified: true
        }
      });
      setMessage("Player link saved.");
      setLinkDraft({ player_uid: "", discord_user_id: "", discord_display_name: "" });
      void loadLinks();
    } catch (error) {
      setMessage(resultError(error, "Player link save failed.").message);
    }
  }

  async function deleteRole(roleId: string) {
    if (!hasToken || !selectedGuild) {
      setMessage("Guild selection required.");
      return;
    }

    try {
      await apiFetch(`/v1/discord/guilds/${encodeURIComponent(selectedGuild.guild_id)}/roles/${encodeURIComponent(roleId)}`, {
        method: "DELETE",
        token
      });
      setMessage("Discord role deleted.");
      void loadGuildDetail(selectedGuild.guild_id);
    } catch (error) {
      setMessage(resultError(error, "Discord role delete failed.").message);
    }
  }

  async function runReconcile(dryRun: boolean) {
    if (!hasToken) {
      setMessage("Token required.");
      return;
    }

    setReconcile({ status: "loading", data: null, error: null });

    try {
      const data = await apiFetch<DiscordReconcileResponse>("/v1/discord/reconcile", {
        method: "POST",
        token,
        body: {
          discord_user_id: reconcileDraft.discord_user_id || undefined,
          user_id: reconcileDraft.user_id || undefined,
          dry_run: dryRun
        }
      });
      setReconcile({ status: "ready", data, error: null });
      setMessage(dryRun ? "Reconcile preview ready." : "Reconciliation applied.");
      if (!dryRun) {
        void loadGuildDetail(selectedGuild?.guild_id ?? "");
      }
    } catch (error) {
      setReconcile(errorResult(error, "Discord reconciliation failed."));
    }
  }

  return (
    <div className="view-grid comms-view">
      {!hasToken ? (
        <CommandPanel title="Token Gate" eyebrow="Secure uplink" wide>
          <p className="message">Enter a bearer token to load Discord integration controls.</p>
        </CommandPanel>
      ) : null}

      {message ? (
        <CommandPanel title="Comms Status" eyebrow="Operator note" wide actions={<button type="button" className="secondary" onClick={() => setMessage("")}>Clear</button>}>
          <p className="message">{message}</p>
        </CommandPanel>
      ) : null}

      <div className="comms-tabs" role="tablist" aria-label="Comms sections">
        {commsTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={activeTab === tab.id ? "active" : ""}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "guilds" ? (
        <div className="tab-panel view-grid">
          <CommandPanel title="Guild Directory" eyebrow="Discord readiness" actions={<button type="button" onClick={() => void loadGuilds()}>Refresh</button>}>
            <DataMessage result={guilds} />
            <div className="discord-selector">
              <select value={selectedGuild?.guild_id ?? ""} onChange={(event) => setSelectedGuildId(event.target.value)} aria-label="Discord guild">
                {guildData.length === 0 ? <option value="">no guilds synced</option> : null}
                {guildData.map((guild) => (
                  <option key={guild.guild_id} value={guild.guild_id}>
                    {guild.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="metric-grid compact">
              <MetricTile label="Guilds" value={guildData.length} />
              <MetricTile label="Roles" value={activeRoleData.length} />
              <MetricTile label="Links" value={selectedGuild?.linked_player_count ?? linkData.length} />
            </div>
            {selectedGuild ? (
              <div className="detail-meta discord-meta">
                <StatusChip label={selectedGuild.bot_present ? "bot present" : "bot absent"} tone={selectedGuild.bot_present ? "ready" : "warn"} />
                <span>{formatDate(selectedGuild.last_role_sync_at)}</span>
              </div>
            ) : null}
          </CommandPanel>

          <CommandPanel title="Auth Guild Policy" eyebrow="Login gate" wide actions={<button type="button" onClick={() => void loadGuilds()}>Refresh</button>}>
            <DataMessage result={authPolicy} />
            <TacticalTable label="Discord auth guild policy" maxVisibleRows={7}>
              <thead>
                <tr>
                  <th>Guild</th>
                  <th>Type</th>
                  <th>Login</th>
                  <th>Priority</th>
                </tr>
              </thead>
              <tbody>
                {authPolicyGuilds.map((guild) => (
                  <tr key={guild.guild_id}>
                    <td>{guild.name}</td>
                    <td>{guild.guild_type ?? "unknown"} / {guild.config_source ?? "db"}</td>
                    <td>
                      <StatusChip label={guild.grants_login ? "grants" : "blocked"} tone={guild.grants_login ? "ready" : "muted"} />
                    </td>
                    <td>U{guild.unit_priority ?? 0} / R{guild.rank_priority ?? 0} / P{guild.permission_priority ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </TacticalTable>
          </CommandPanel>
        </div>
      ) : null}

      {activeTab === "unit-mapping" ? (
        <div className="tab-panel view-grid">
          <CommandPanel title="Unit Mapping" eyebrow="Discord role to roster" wide actions={<button type="button" onClick={() => void loadGuildDetail(selectedGuild?.guild_id ?? "")}>Refresh</button>}>
            <div className="discord-selector">
              <select value={selectedGuild?.guild_id ?? ""} onChange={(event) => setSelectedGuildId(event.target.value)} aria-label="Discord guild for unit mapping">
                {guildData.length === 0 ? <option value="">no guilds synced</option> : null}
                {guildData.map((guild) => (
                  <option key={guild.guild_id} value={guild.guild_id}>
                    {guild.name}
                  </option>
                ))}
              </select>
            </div>
            <form className="filters discord-role-form" onSubmit={createRole}>
              <input value={roleDraft.role_id} onChange={(event) => setRoleDraft({ ...roleDraft, role_id: event.target.value })} placeholder="discord role id" aria-label="Discord role ID" />
              <input value={roleDraft.name} onChange={(event) => setRoleDraft({ ...roleDraft, name: event.target.value })} placeholder="friendly role name" aria-label="Friendly role name" />
              <select value={roleDraft.unit_id} onChange={(event) => setRoleDraft({ ...roleDraft, unit_id: event.target.value })} aria-label="Unit to link to">
                <option value="">unit to link to</option>
                {unitData.map((unit) => (
                  <option key={unit.unit_id} value={unit.unit_id}>
                    {unit.display_name ?? unit.name}
                  </option>
                ))}
              </select>
              <input value={roleDraft.priority} onChange={(event) => setRoleDraft({ ...roleDraft, priority: event.target.value })} placeholder="priority" aria-label="Mapping priority" />
              <button type="submit" disabled={!hasToken || !selectedGuild || roleDraft.role_id.length === 0 || roleDraft.name.length === 0 || roleDraft.unit_id.length === 0}>
                Attach Role
              </button>
            </form>
            <DataMessage result={roles} />
            <DataMessage result={mappings} />
            <DataMessage result={units} />
            <TacticalTable label="Unit role mappings" maxVisibleRows={8}>
              <thead>
                <tr>
                  <th>Role ID</th>
                  <th>Friendly Name</th>
                  <th>Linked Unit</th>
                  <th>Priority</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {unitMappingRows.map((row) => (
                  <tr key={row.key}>
                    <td>
                      <p className="mono">{row.role_id}</p>
                    </td>
                    <td>{row.friendly_name}</td>
                    <td>{displayValue(row.linked_unit)}</td>
                    <td>{row.priority}</td>
                    <td>
                      <button type="button" className="secondary" onClick={() => void deleteRole(row.role_id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </TacticalTable>
          </CommandPanel>
        </div>
      ) : null}

      {activeTab === "players" ? (
        <div className="tab-panel view-grid">
          <CommandPanel title="Player Links" eyebrow="Roster mapping" wide>
            <form className="filters discord-link-form" onSubmit={createLink}>
              <input value={linkDraft.player_uid} onChange={(event) => setLinkDraft({ ...linkDraft, player_uid: event.target.value })} placeholder="player_uid" aria-label="Player UID" />
              <input value={linkDraft.discord_user_id} onChange={(event) => setLinkDraft({ ...linkDraft, discord_user_id: event.target.value })} placeholder="discord_user_id" aria-label="Discord user ID" />
              <input value={linkDraft.discord_display_name} onChange={(event) => setLinkDraft({ ...linkDraft, discord_display_name: event.target.value })} placeholder="display name" aria-label="Discord display name" />
              <button type="submit" disabled={!hasToken || linkDraft.player_uid.length === 0 || linkDraft.discord_user_id.length === 0}>
                Save Link
              </button>
            </form>
            <DataMessage result={links} />
            <TacticalTable label="Discord player links" maxVisibleRows={10}>
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Discord</th>
                  <th>Source</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {linkData.map((link) => (
                  <tr key={link.discord_user_id}>
                    <td>{displayValue(link.player_name) !== "n/a" ? displayValue(link.player_name) : link.player_uid}</td>
                    <td>{displayValue(link.discord_display_name ?? link.discord_username ?? link.discord_user_id)}</td>
                    <td>{link.source}</td>
                    <td>{formatDate(link.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </TacticalTable>
          </CommandPanel>
        </div>
      ) : null}

      {activeTab === "sync" ? (
        <div className="tab-panel view-grid">
          <CommandPanel
            title="Reconcile Preview"
            eyebrow="Membership sync"
            wide
            actions={
              <>
                <button type="button" onClick={() => void runReconcile(true)} disabled={!hasToken || (reconcileDraft.discord_user_id.length === 0 && reconcileDraft.user_id.length === 0)}>
                  Dry Run
                </button>
                <button type="button" onClick={() => void runReconcile(false)} disabled={!hasToken || (reconcileDraft.discord_user_id.length === 0 && reconcileDraft.user_id.length === 0)}>
                  Apply
                </button>
              </>
            }
          >
            <div className="filters">
              <input value={reconcileDraft.discord_user_id} onChange={(event) => setReconcileDraft({ ...reconcileDraft, discord_user_id: event.target.value })} placeholder="discord_user_id" aria-label="Discord user ID" />
              <input value={reconcileDraft.user_id} onChange={(event) => setReconcileDraft({ ...reconcileDraft, user_id: event.target.value })} placeholder="user_id" aria-label="User ID" />
            </div>
            <DataMessage result={reconcile} />
            {reconcile.status === "ready" ? (
              <div className="metric-grid compact discord-eval-metrics">
                <MetricTile label="Denied" value={reconcile.data.denied ? "yes" : "no"} />
                <MetricTile label="Locked" value={reconcile.data.manual_locked ? "yes" : "no"} />
                <MetricTile label="Applied" value={reconcile.data.applied.length} />
                <MetricTile label="Ignored" value={reconcile.data.ignored_claims.length} />
              </div>
            ) : null}
            <TacticalTable label="Winning Discord claims" maxVisibleRows={4}>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Guild</th>
                  <th>Role</th>
                  <th>Target</th>
                </tr>
              </thead>
              <tbody>
                {reconcile.status === "ready" ? (
                  ([
                    ["unit", reconcile.data.winning_claims.unit_primary],
                    ["rank", reconcile.data.winning_claims.rank],
                    ["status", reconcile.data.winning_claims.roster_status]
                  ] as Array<[string, DiscordRoleClaim | null]>).map(([field, claim]) => (
                    <tr key={String(field)}>
                      <td>{String(field)}</td>
                      <td>{claim ? claim.guildId : "n/a"}</td>
                      <td>{claim ? displayValue(claim.roleName ?? claim.roleId) : "n/a"}</td>
                      <td>{claim ? displayValue(claim.unitId ?? claim.rankId ?? claim.rosterStatus) : "n/a"}</td>
                    </tr>
                  ))
                ) : null}
              </tbody>
            </TacticalTable>
          </CommandPanel>
        </div>
      ) : null}

      {activeTab === "audit" ? (
        <div className="tab-panel view-grid">
          <CommandPanel title="Audit Trail" eyebrow="Bot handoff" wide actions={<button type="button" onClick={() => void loadGuildDetail(selectedGuild?.guild_id ?? "")}>Refresh</button>}>
            <DataMessage result={audits} />
            <TacticalTable label="Discord role action audits" maxVisibleRows={7}>
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Status</th>
                  <th>Player</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {auditData.map((audit) => (
                  <tr key={audit.id}>
                    <td>{audit.action}</td>
                    <td>{audit.status}</td>
                    <td>{displayValue(audit.player_uid)}</td>
                    <td>{formatDate(audit.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </TacticalTable>
            <TacticalTable label="Discord assignment audits" maxVisibleRows={6}>
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Field</th>
                  <th>Player</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {assignmentAuditData.map((audit) => (
                  <tr key={audit.id}>
                    <td>{audit.action}</td>
                    <td>{audit.field}</td>
                    <td>{displayValue(audit.player_uid ?? audit.discord_user_id)}</td>
                    <td>{formatDate(audit.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </TacticalTable>
          </CommandPanel>
        </div>
      ) : null}
    </div>
  );
}
