import type { ReactNode } from "react";

import { statusLabel } from "../format";
import type { ApiResult, DbHealthResponse, HealthResponse, ViewName } from "../types";
import { StatusChip } from "./StatusChip";
import { TokenGate } from "./TokenGate";

const navigation: Array<{ view: ViewName; label: string; code: string }> = [
  { view: "dashboard", label: "Command", code: "CMD" },
  { view: "operations", label: "Operations", code: "OPS" },
  { view: "players", label: "Roster", code: "RST" }
];

export function CommandShell({
  view,
  health,
  dbHealth,
  hasToken,
  tokenDraft,
  onViewChange,
  onTokenDraftChange,
  onTokenSave,
  onTokenForget,
  children,
  inspector
}: {
  view: ViewName;
  health: ApiResult<HealthResponse>;
  dbHealth: ApiResult<DbHealthResponse>;
  hasToken: boolean;
  tokenDraft: string;
  onViewChange: (view: ViewName) => void;
  onTokenDraftChange: (value: string) => void;
  onTokenSave: React.FormEventHandler<HTMLFormElement>;
  onTokenForget: () => void;
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
          <StatusChip
            label={`DB ${hasToken ? statusLabel(dbHealth) : "token required"}`}
            tone={dbHealth.status === "error" ? "danger" : dbHealth.status === "ready" ? "ready" : "warn"}
          />
          <StatusChip label={hasToken ? "token linked" : "token offline"} tone={hasToken ? "info" : "muted"} />
        </div>
      </header>

      <aside className="nav-rail" aria-label="Dashboard views">
        {navigation.map((item) => (
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

      <section className="token-station" aria-label="API token station">
        <TokenGate
          tokenDraft={tokenDraft}
          hasToken={hasToken}
          onDraftChange={onTokenDraftChange}
          onSave={onTokenSave}
          onForget={onTokenForget}
        />
      </section>

      <section className="viewport" data-view={view}>
        <div key={view} className="view-transition-layer">
          {children}
        </div>
      </section>
      <aside className="inspection-pane">{inspector}</aside>
    </main>
  );
}
