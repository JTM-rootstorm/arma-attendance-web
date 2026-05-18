import { FormEvent, useMemo, useState } from "react";

import { apiFetch } from "../api";
import { CommandPanel } from "../components/CommandPanel";
import { StatusChip } from "../components/StatusChip";
import { TacticalTable } from "../components/TacticalTable";
import { displayValue, formatDate, resultError } from "../format";
import type { AdminUsersResponse, ApiResult, AuthUser, MeResponse } from "../types";

const manageableRoles = ["owner", "admin", "officer", "viewer"] as const;

function hasAdminRole(user: AuthUser | null): boolean {
  return Boolean(user?.roles.some((role) => role === "owner" || role === "admin"));
}

function roleTone(role: string) {
  return role === "owner" || role === "admin" ? "ready" : role === "officer" ? "info" : "muted";
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

export function IdentityPage({
  me,
  adminUsers,
  onLoginDiscord,
  onLogout,
  onRefreshMe,
  onRefreshAdminUsers
}: {
  me: ApiResult<MeResponse>;
  adminUsers: ApiResult<AdminUsersResponse>;
  onLoginDiscord: () => void;
  onLogout: () => void;
  onRefreshMe: () => void;
  onRefreshAdminUsers: () => void;
}) {
  const currentUser = me.status === "ready" ? me.data.user : null;
  const users = adminUsers.status === "ready" ? adminUsers.data.users : [];
  const steamIdentity = currentUser?.identities.find((identity) => identity.provider === "steam") ?? null;
  const discordIdentity = currentUser?.identities.find((identity) => identity.provider === "discord") ?? null;
  const canAdmin = hasAdminRole(currentUser);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedRole, setSelectedRole] = useState<(typeof manageableRoles)[number]>("viewer");
  const [message, setMessage] = useState("");
  const selectedUser = useMemo(() => users.find((user) => user.id === selectedUserId) ?? users[0] ?? null, [selectedUserId, users]);

  async function unlinkSteam() {
    try {
      await apiFetch("/v1/me/identities/steam", { method: "DELETE" });
      setMessage("Steam identity unlinked.");
      onRefreshMe();
    } catch (error) {
      setMessage(resultError(error, "Steam unlink failed.").message);
    }
  }

  async function mutateRole(event: FormEvent<HTMLFormElement>, action: "grant" | "revoke") {
    event.preventDefault();

    if (!selectedUser) {
      setMessage("Select a user first.");
      return;
    }

    try {
      await apiFetch(`/v1/admin/users/${selectedUser.id}/roles/${selectedRole}`, {
        method: action === "grant" ? "PUT" : "DELETE",
        body: { reason: "updated from admin console" }
      });
      setMessage(`${action === "grant" ? "Granted" : "Revoked"} ${selectedRole}.`);
      onRefreshAdminUsers();
      onRefreshMe();
    } catch (error) {
      setMessage(resultError(error, "Role update failed.").message);
    }
  }

  async function setDisabled(disabled: boolean) {
    if (!selectedUser) {
      return;
    }

    try {
      await apiFetch(`/v1/admin/users/${selectedUser.id}/${disabled ? "disable" : "enable"}`, { method: "POST" });
      setMessage(disabled ? "User disabled." : "User enabled.");
      onRefreshAdminUsers();
    } catch (error) {
      setMessage(resultError(error, "User status update failed.").message);
    }
  }

  return (
    <div className="view-grid">
      <CommandPanel
        title="Account"
        eyebrow="Identity session"
        wide
        actions={
          currentUser ? (
            <>
              <button type="button" onClick={onRefreshMe}>Refresh</button>
              <button type="button" className="secondary" onClick={onLogout}>Logout</button>
            </>
          ) : (
            <button type="button" onClick={onLoginDiscord}>Login with Discord</button>
          )
        }
      >
        <DataMessage result={me} />
        {currentUser ? (
          <div className="identity-account-grid">
            <div>
              <h3>{displayValue(currentUser.display_name)}</h3>
              <p className="mono">{currentUser.id}</p>
              <div className="detail-meta">
                {currentUser.roles.length === 0 ? <StatusChip label="no roles" tone="warn" /> : null}
                {currentUser.roles.map((role) => (
                  <StatusChip key={role} label={role} tone={roleTone(role)} />
                ))}
              </div>
            </div>
            <div className="identity-stack">
              <div>
                <span>Discord</span>
                <strong className="mono">{displayValue(discordIdentity?.provider_user_id)}</strong>
              </div>
              <div>
                <span>Steam</span>
                <strong className="mono">{displayValue(steamIdentity?.provider_user_id)}</strong>
              </div>
              <div className="token-actions">
                {steamIdentity ? (
                  <button type="button" className="secondary" onClick={() => void unlinkSteam()}>Unlink Steam</button>
                ) : (
                  <button type="button" onClick={() => { window.location.href = "/auth/steam/start"; }}>Link Steam</button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <p className="message">Use Discord OAuth to create or resume a browser session. Machine-token access remains available for automation.</p>
        )}
      </CommandPanel>

      {message ? (
        <CommandPanel title="Identity Status" eyebrow="Operator note" wide actions={<button type="button" className="secondary" onClick={() => setMessage("")}>Clear</button>}>
          <p className="message">{message}</p>
        </CommandPanel>
      ) : null}

      {canAdmin ? (
        <CommandPanel title="Admin Users" eyebrow="Role management" wide actions={<button type="button" onClick={onRefreshAdminUsers}>Refresh</button>}>
          <DataMessage result={adminUsers} />
          <form className="filters identity-role-form" onSubmit={(event) => void mutateRole(event, "grant")}>
            <select value={selectedUser?.id ?? ""} onChange={(event) => setSelectedUserId(event.target.value)} aria-label="Admin user">
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.display_name ?? user.id}
                </option>
              ))}
            </select>
            <select value={selectedRole} onChange={(event) => setSelectedRole(event.target.value as typeof selectedRole)} aria-label="Role">
              {manageableRoles.map((role) => (
                <option key={role} value={role}>{role}</option>
              ))}
            </select>
            <button type="submit">Grant</button>
            <button type="button" className="secondary" onClick={(event) => void mutateRole(event as unknown as FormEvent<HTMLFormElement>, "revoke")}>Revoke</button>
            <button type="button" className="secondary" onClick={() => void setDisabled(!(selectedUser?.disabled_at))}>
              {selectedUser?.disabled_at ? "Enable" : "Disable"}
            </button>
          </form>
          <TacticalTable label="Admin users" maxVisibleRows={8}>
            <thead>
              <tr>
                <th>User</th>
                <th>Roles</th>
                <th>Identities</th>
                <th>Last Login</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className={user.id === selectedUser?.id ? "selected" : ""} onClick={() => setSelectedUserId(user.id)}>
                  <td>{displayValue(user.display_name)}<br /><span className="mono">{user.id}</span></td>
                  <td>{user.roles.length > 0 ? user.roles.join(", ") : "none"}</td>
                  <td>{user.identities.map((identity) => `${identity.provider}:${identity.provider_user_id}`).join(", ") || "none"}</td>
                  <td>{formatDate(user.last_login_at)}</td>
                </tr>
              ))}
            </tbody>
          </TacticalTable>
        </CommandPanel>
      ) : null}
    </div>
  );
}
