import type { FormEvent } from "react";

export function TokenGate({
  tokenDraft,
  hasToken,
  onDraftChange,
  onSave,
  onForget
}: {
  tokenDraft: string;
  hasToken: boolean;
  onDraftChange: (value: string) => void;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
  onForget: () => void;
}) {
  return (
    <form className="token-gate" onSubmit={onSave}>
      <label htmlFor="token">Bearer Token</label>
      <input
        id="token"
        type="password"
        value={tokenDraft}
        onChange={(event) => onDraftChange(event.target.value)}
        placeholder="dev-token"
        autoComplete="off"
      />
      <div className="token-actions">
        <button type="submit">{hasToken ? "Refresh" : "Connect"}</button>
        <button type="button" className="secondary" onClick={onForget}>
          Clear
        </button>
      </div>
    </form>
  );
}
