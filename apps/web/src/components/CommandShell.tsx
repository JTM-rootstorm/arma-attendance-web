import type { ReactNode } from "react";

import { canOpenComms, canOpenDashboard, canOpenIdentityAdmin, canOpenOperations, canOpenRoster, isOwner } from "../authz";
import { statusLabel } from "../format";
import type { ApiResult, AuthUser, DbHealthResponse, HealthResponse, ViewName } from "../types";
import { StatusChip } from "./StatusChip";
import { TokenGate } from "./TokenGate";

const navigation: Array<{ view: ViewName; label: string; code: string; allowed: (user: AuthUser | null) => boolean }> = [
  { view: "me", label: "My Stats", code: "ME", allowed: (user) => Boolean(user) },
  { view: "dashboard", label: "Command", code: "CMD", allowed: canOpenDashboard },
  { view: "operations", label: "Operations", code: "OPS", allowed: canOpenOperations },
  { view: "players", label: "Roster", code: "RST", allowed: canOpenRoster },
  { view: "discord", label: "Comms", code: "COM", allowed: canOpenComms },
  { view: "admin", label: "Identity", code: "ID", allowed: canOpenIdentityAdmin }
];

export function CommandShell({
  view,
  health,
  dbHealth,
  hasToken,
  tokenDraft,
  sessionUser,
  onViewChange,
  onTokenDraftChange,
  onTokenSave,
  onTokenForget,
  onLoginDiscord,
  onLogout,
  children,
  inspector
}: {
  view: ViewName;
  health: ApiResult<HealthResponse>;
  dbHealth: ApiResult<DbHealthResponse>;
  hasToken: boolean;
  tokenDraft: string;
  sessionUser: AuthUser | null;
  onViewChange: (view: ViewName) => void;
  onTokenDraftChange: (value: string) => void;
  onTokenSave: React.FormEventHandler<HTMLFormElement>;
  onTokenForget: () => void;
  onLoginDiscord: () => void;
  onLogout: () => void;
  children: ReactNode;
  inspector: ReactNode;
}) {
  return (
    <main className="console-shell">
      <header className="command-bar">
        <div>
          <p className="console-glyphs" aria-hidden="true">
            command telemetry
          </p>
          <p className="eyebrow">Command Console</p>
          <h1>Arma Attendance Tracker</h1>
        </div>
        <div className="status-strip" aria-label="Service status">
          <StatusChip label={`API ${statusLabel(health)}`} tone={health.status === "error" ? "danger" : health.status === "ready" ? "ready" : "muted"} />
          {isOwner(sessionUser) ? (
            <StatusChip
              label={`DB ${statusLabel(dbHealth)}`}
              tone={dbHealth.status === "error" ? "danger" : dbHealth.status === "ready" ? "ready" : "warn"}
            />
          ) : null}
          <StatusChip label={sessionUser ? "session linked" : "session offline"} tone={sessionUser ? "info" : "muted"} />
        </div>
      </header>

      <aside className="nav-rail" aria-label="Dashboard views">
        {navigation.filter((item) => item.allowed(sessionUser)).map((item) => (
          <button
            key={item.view}
            className={view === item.view ? "active" : ""}
            type="button"
            onClick={() => onViewChange(item.view)}
            title={item.label}
          >
            <span>{item.code}</span>
            <strong>{item.label}</strong>
          </button>
        ))}
      </aside>

      {isOwner(sessionUser) ? (
        <section className="token-station" aria-label="Machine token diagnostics">
          <TokenGate
            tokenDraft={tokenDraft}
            hasToken={hasToken}
            sessionUser={sessionUser}
            onDraftChange={onTokenDraftChange}
            onSave={onTokenSave}
            onForget={onTokenForget}
            onLoginDiscord={onLoginDiscord}
            onLogout={onLogout}
            onOpenIdentity={() => onViewChange("admin")}
          />
        </section>
      ) : null}

      <section className="viewport" data-view={view}>
        <div key={view} className="view-transition-layer">
          {children}
        </div>
      </section>
      <aside className="inspection-pane">{inspector}</aside>
    </main>
  );
}
