import type { FormEvent } from "react";

import type { AuthUser } from "../types";

export function TokenGate({
  tokenDraft,
  hasToken,
  sessionUser,
  onDraftChange,
  onSave,
  onForget,
  onLoginDiscord,
  onLogout,
  onOpenIdentity
}: {
  tokenDraft: string;
  hasToken: boolean;
  sessionUser: AuthUser | null;
  onDraftChange: (value: string) => void;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
  onForget: () => void;
  onLoginDiscord: () => void;
  onLogout: () => void;
  onOpenIdentity: () => void;
}) {
  return (
    <form className="token-gate auth-token-gate" onSubmit={onSave}>
      <div className="session-summary">
        <span>Session</span>
        <strong>{sessionUser?.display_name ?? "offline"}</strong>
      </div>
      <div className="token-field">
        <label htmlFor="token">Bearer Token</label>
        <input
          id="token"
          type="password"
          value={tokenDraft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder="dev-token"
          autoComplete="off"
        />
      </div>
      <div className="token-actions">
        <button type="button" onClick={sessionUser ? onOpenIdentity : onLoginDiscord}>
          {sessionUser ? "Account" : "Login Discord"}
        </button>
        {sessionUser ? (
          <button type="button" className="secondary" onClick={onLogout}>
            Logout
          </button>
        ) : null}
        <button type="submit">{hasToken ? "Refresh" : "Connect"}</button>
        <button type="button" className="secondary" onClick={onForget}>
          Clear
        </button>
      </div>
    </form>
  );
}
