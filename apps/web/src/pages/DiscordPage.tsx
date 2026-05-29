import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch } from "../api";
import { CommandPanel } from "../components/CommandPanel";
import { MetricTile } from "../components/MetricTile";
import { StatusChip } from "../components/StatusChip";
import { TacticalTable } from "../components/TacticalTable";
import { displayValue, formatDate, resultError } from "../format";
import type {
  ApiResult,
  DiscordAuditsResponse,
  DiscordGuild,
  DiscordGuildsResponse,
  DiscordPlayerLinksResponse,
  DiscordRoleActionsResponse,
  DiscordRolesResponse,
  DiscordRulesResponse
} from "../types";

const emptyResult: ApiResult<never> = { status: "idle", data: null, error: null };

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

function formatPercent(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") {
    return "n/a";
  }

  return `${Number(value).toFixed(1)}%`;
}

export function DiscordPage({ hasToken, token }: { hasToken: boolean; token: string }) {
  const [guilds, setGuilds] = useState<ApiResult<DiscordGuildsResponse>>(emptyResult);
  const [roles, setRoles] = useState<ApiResult<DiscordRolesResponse>>(emptyResult);
  const [links, setLinks] = useState<ApiResult<DiscordPlayerLinksResponse>>(emptyResult);
  const [rules, setRules] = useState<ApiResult<DiscordRulesResponse>>(emptyResult);
  const [actions, setActions] = useState<ApiResult<DiscordRoleActionsResponse>>(emptyResult);
  const [audits, setAudits] = useState<ApiResult<DiscordAuditsResponse>>(emptyResult);
  const [selectedGuildId, setSelectedGuildId] = useState("");
  const [linkDraft, setLinkDraft] = useState({ player_uid: "", discord_user_id: "", discord_display_name: "" });
  const [ruleDraft, setRuleDraft] = useState({
    name: "",
    role_id: "",
    min_attendance_points: "1",
    min_attendance_percent: "",
    lookback_days: "",
    server_key: ""
  });
  const [message, setMessage] = useState("");

  const guildData = guilds.status === "ready" ? guilds.data.guilds : [];
  const roleData = roles.status === "ready" ? roles.data.roles : [];
  const linkData = links.status === "ready" ? links.data.links : [];
  const ruleData = rules.status === "ready" ? rules.data.rules : [];
  const auditData = audits.status === "ready" ? audits.data.audits : [];
  const actionData = actions.status === "ready" ? [...actions.data.actions, ...actions.data.skipped] : [];
  const selectedGuild = useMemo(() => selectedGuildFrom(guildData, selectedGuildId), [guildData, selectedGuildId]);

  const loadGuilds = useCallback(async () => {
    if (!hasToken) {
      setGuilds(emptyResult);
      return;
    }

    setGuilds({ status: "loading", data: null, error: null });

    try {
      const data = await apiFetch<DiscordGuildsResponse>("/v1/discord/guilds", { token });
      setGuilds({ status: "ready", data, error: null });
      setSelectedGuildId((current) => current || data.guilds[0]?.guild_id || "");
    } catch (error) {
      setGuilds(errorResult(error, "Discord guilds failed."));
    }
  }, [hasToken, token]);

  const loadGuildDetail = useCallback(
    async (guildId: string) => {
      if (!hasToken || guildId.length === 0) {
        setRoles(emptyResult);
        setRules(emptyResult);
        setActions(emptyResult);
        setAudits(emptyResult);
        return;
      }

      setRoles({ status: "loading", data: null, error: null });
      setRules({ status: "loading", data: null, error: null });
      setAudits({ status: "loading", data: null, error: null });

      try {
        const [nextRoles, nextRules, nextAudits] = await Promise.all([
          apiFetch<DiscordRolesResponse>(`/v1/discord/guilds/${encodeURIComponent(guildId)}/roles`, { token }),
          apiFetch<DiscordRulesResponse>(`/v1/discord/guilds/${encodeURIComponent(guildId)}/rules`, { token }),
          apiFetch<DiscordAuditsResponse>(`/v1/discord/guilds/${encodeURIComponent(guildId)}/role-action-audits`, { token })
        ]);

        setRoles({ status: "ready", data: nextRoles, error: null });
        setRules({ status: "ready", data: nextRules, error: null });
        setAudits({ status: "ready", data: nextAudits, error: null });
        setRuleDraft((draft) => ({ ...draft, role_id: draft.role_id || nextRoles.roles.find((role) => role.assignable)?.role_id || "" }));
      } catch (error) {
        setRoles(errorResult(error, "Discord roles failed."));
        setRules(errorResult(error, "Discord rules failed."));
        setAudits(errorResult(error, "Discord audits failed."));
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

  useEffect(() => {
    void loadGuilds();
    void loadLinks();
  }, [loadGuilds, loadLinks]);

  useEffect(() => {
    void loadGuildDetail(selectedGuild?.guild_id ?? "");
  }, [loadGuildDetail, selectedGuild?.guild_id]);

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

  async function createRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!hasToken || !selectedGuild) {
      setMessage("Guild selection required.");
      return;
    }

    try {
      await apiFetch(`/v1/discord/guilds/${encodeURIComponent(selectedGuild.guild_id)}/rules`, {
        method: "POST",
        token,
        body: {
          role_id: ruleDraft.role_id,
          name: ruleDraft.name,
          min_attendance_points: Number(ruleDraft.min_attendance_points || 0),
          min_operation_count: Number(ruleDraft.min_attendance_points || 0),
          min_attendance_percent: ruleDraft.min_attendance_percent ? Number(ruleDraft.min_attendance_percent) : null,
          lookback_days: ruleDraft.lookback_days ? Number(ruleDraft.lookback_days) : null,
          server_key: ruleDraft.server_key || null,
          require_present_at_end: true,
          include_started_operations: false,
          grant_mode: "grant_and_revoke_preview"
        }
      });
      setMessage("Attendance rule saved.");
      setRuleDraft((draft) => ({ ...draft, name: "" }));
      void loadGuildDetail(selectedGuild.guild_id);
    } catch (error) {
      setMessage(resultError(error, "Attendance rule save failed.").message);
    }
  }

  async function evaluateRoles(persist: boolean) {
    if (!hasToken || !selectedGuild) {
      setMessage("Guild selection required.");
      return;
    }

    setActions({ status: "loading", data: null, error: null });

    try {
      const data = await apiFetch<DiscordRoleActionsResponse>(
        `/v1/discord/guilds/${encodeURIComponent(selectedGuild.guild_id)}/role-actions`,
        {
          token,
          params: {
            dry_run: persist ? "false" : "true",
            persist: persist ? "true" : "false"
          }
        }
      );
      setActions({ status: "ready", data, error: null });
      setMessage(persist ? "Role evaluation persisted." : "Dry-run evaluation ready.");
      if (persist) {
        void loadGuildDetail(selectedGuild.guild_id);
      }
    } catch (error) {
      setActions(errorResult(error, "Role evaluation failed."));
    }
  }

  return (
    <div className="view-grid">
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

      <CommandPanel title="Guild Status" eyebrow="Discord readiness" actions={<button type="button" onClick={() => void loadGuilds()}>Refresh</button>}>
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
          <MetricTile label="Roles" value={selectedGuild?.role_count ?? 0} />
          <MetricTile label="Links" value={selectedGuild?.linked_player_count ?? linkData.length} />
          <MetricTile label="Rules" value={selectedGuild?.enabled_rule_count ?? 0} detail="enabled" />
        </div>
        {selectedGuild ? (
          <div className="detail-meta discord-meta">
            <StatusChip label={selectedGuild.bot_present ? "bot present" : "bot absent"} tone={selectedGuild.bot_present ? "ready" : "warn"} />
            <span>{formatDate(selectedGuild.last_role_sync_at)}</span>
          </div>
        ) : null}
      </CommandPanel>

      <CommandPanel title="Role Snapshot" eyebrow="Assignable roles" actions={<button type="button" onClick={() => void loadGuildDetail(selectedGuild?.guild_id ?? "")}>Refresh</button>}>
        <DataMessage result={roles} />
        <TacticalTable label="Discord roles" maxVisibleRows={6}>
          <thead>
            <tr>
              <th>Role</th>
              <th>State</th>
              <th>Position</th>
            </tr>
          </thead>
          <tbody>
            {roleData.map((role) => (
              <tr key={role.role_id}>
                <td>{role.name}</td>
                <td>
                  <StatusChip label={role.assignable && !role.managed && !role.is_deleted ? "assignable" : "blocked"} tone={role.assignable && !role.managed && !role.is_deleted ? "ready" : "muted"} />
                </td>
                <td>{displayValue(role.position)}</td>
              </tr>
            ))}
          </tbody>
        </TacticalTable>
      </CommandPanel>

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
        <TacticalTable label="Discord player links" maxVisibleRows={6}>
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

      <CommandPanel title="Attendance Rules" eyebrow="Role policy" wide>
        <form className="filters discord-rule-form" onSubmit={createRule}>
          <input value={ruleDraft.name} onChange={(event) => setRuleDraft({ ...ruleDraft, name: event.target.value })} placeholder="rule name" aria-label="Rule name" />
          <select value={ruleDraft.role_id} onChange={(event) => setRuleDraft({ ...ruleDraft, role_id: event.target.value })} aria-label="Discord role">
            <option value="">select role</option>
            {roleData.map((role) => (
              <option key={role.role_id} value={role.role_id}>
                {role.name}
              </option>
            ))}
          </select>
          <input value={ruleDraft.min_attendance_points} onChange={(event) => setRuleDraft({ ...ruleDraft, min_attendance_points: event.target.value })} placeholder="points" aria-label="Minimum attendance points" />
          <input value={ruleDraft.min_attendance_percent} onChange={(event) => setRuleDraft({ ...ruleDraft, min_attendance_percent: event.target.value })} placeholder="percent" aria-label="Minimum attendance percent" />
          <input value={ruleDraft.lookback_days} onChange={(event) => setRuleDraft({ ...ruleDraft, lookback_days: event.target.value })} placeholder="lookback days" aria-label="Lookback days" />
          <input value={ruleDraft.server_key} onChange={(event) => setRuleDraft({ ...ruleDraft, server_key: event.target.value })} placeholder="server_key" aria-label="Server key" />
          <button type="submit" disabled={!hasToken || !selectedGuild || ruleDraft.name.length === 0 || ruleDraft.role_id.length === 0}>
            Save Rule
          </button>
        </form>
        <DataMessage result={rules} />
        <TacticalTable label="Discord attendance rules" maxVisibleRows={6}>
          <thead>
            <tr>
              <th>Rule</th>
              <th>Role</th>
              <th>Threshold</th>
              <th>Scope</th>
            </tr>
          </thead>
          <tbody>
            {ruleData.map((rule) => (
              <tr key={rule.id}>
                <td>
                  <StatusChip label={rule.is_enabled ? "enabled" : "off"} tone={rule.is_enabled ? "ready" : "muted"} /> {rule.name}
                </td>
                <td>{displayValue(rule.role_name ?? rule.role_id)}</td>
                <td>{rule.min_attendance_points} pts / {formatPercent(rule.min_attendance_percent)}</td>
                <td>{displayValue(rule.server_key)} / {displayValue(rule.lookback_days ? `${rule.lookback_days}d` : null)}</td>
              </tr>
            ))}
          </tbody>
        </TacticalTable>
      </CommandPanel>

      <CommandPanel
        title="Evaluation"
        eyebrow="Role action preview"
        wide
        actions={
          <>
            <button type="button" onClick={() => void evaluateRoles(false)} disabled={!hasToken || !selectedGuild}>
              Dry Run
            </button>
            <button type="button" onClick={() => void evaluateRoles(true)} disabled={!hasToken || !selectedGuild}>
              Persist
            </button>
          </>
        }
      >
        <DataMessage result={actions} />
        {actions.status === "ready" ? (
          <div className="metric-grid compact discord-eval-metrics">
            <MetricTile label="Rules" value={actions.data.summary.rules_evaluated} />
            <MetricTile label="Players" value={actions.data.summary.players_evaluated} />
            <MetricTile label="Grants" value={actions.data.summary.grant_count} />
          </div>
        ) : null}
        <TacticalTable label="Discord role actions" maxVisibleRows={7}>
          <thead>
            <tr>
              <th>Action</th>
              <th>Player</th>
              <th>Role</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>
            {actionData.map((action) => (
              <tr key={`${action.action}-${action.rule_id}-${action.player_uid}-${action.role_id}`}>
                <td>{action.action}</td>
                <td>{displayValue(action.player_name ?? action.player_uid)}</td>
                <td>{action.role_name}</td>
                <td>{action.score.attendance_points} pts / {formatPercent(action.score.attendance_percent)}</td>
              </tr>
            ))}
          </tbody>
        </TacticalTable>
      </CommandPanel>

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
      </CommandPanel>
    </div>
  );
}
