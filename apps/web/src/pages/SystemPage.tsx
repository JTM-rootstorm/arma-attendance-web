import { FormEvent, useState } from "react";

import type { ApiResult, CreateMachineTokenResponse, MachineTokensResponse } from "../types";

export function SystemPage({
  machineTokens,
  createdToken,
  onCreateToken,
  onRevokeToken,
  onRefresh
}: {
  machineTokens: ApiResult<MachineTokensResponse>;
  createdToken: CreateMachineTokenResponse | null;
  onCreateToken: (input: { name: string; token_kind: "api" | "bot" | "arma_server" }) => Promise<void>;
  onRevokeToken: (tokenId: string) => Promise<void>;
  onRefresh: () => void;
}) {
  const [name, setName] = useState("");
  const [tokenKind, setTokenKind] = useState<"api" | "bot" | "arma_server">("arma_server");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onCreateToken({ name: name.trim(), token_kind: tokenKind });
    setName("");
  }

  return (
    <section className="view-grid system-grid">
      <div className="command-panel wide">
        <div className="panel-header">
          <div>
            <p className="eyebrow">System</p>
            <h2>Machine Tokens</h2>
          </div>
          <button type="button" onClick={onRefresh}>
            Refresh
          </button>
        </div>

        {machineTokens.status === "error" ? <p className="error-line">{machineTokens.error}</p> : null}

        {createdToken ? (
          <div className="once-token">
            <span>New token shown once</span>
            <code>{createdToken.token}</code>
          </div>
        ) : null}

        <form className="inline-form" onSubmit={(event) => void submit(event)}>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Token name" />
          <select value={tokenKind} onChange={(event) => setTokenKind(event.target.value as "api" | "bot" | "arma_server")}>
            <option value="arma_server">Arma server</option>
            <option value="bot">Discord bot</option>
            <option value="api">API automation</option>
          </select>
          <button type="submit" disabled={name.trim().length === 0}>
            Create
          </button>
        </form>

        <div className="tactical-table">
          <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kind</th>
                  <th>Prefix</th>
                  <th>Status</th>
                  <th>Last Used</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {machineTokens.status === "ready" && machineTokens.data.tokens.length > 0 ? (
                  machineTokens.data.tokens.map((token) => (
                    <tr key={token.id}>
                      <td>{token.name}</td>
                      <td>{token.token_kind}</td>
                      <td>
                        <code>{token.token_prefix}</code>
                      </td>
                      <td>{token.is_active && !token.revoked_at ? "active" : "revoked"}</td>
                      <td>{token.last_used_at ? new Date(token.last_used_at).toLocaleString() : "never"}</td>
                      <td>
                        {token.is_active && !token.revoked_at ? (
                          <button type="button" className="secondary" onClick={() => void onRevokeToken(token.id)}>
                            Revoke
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6}>{machineTokens.status === "loading" ? "Loading tokens." : "No DB-backed machine tokens."}</td>
                  </tr>
                )}
              </tbody>
            </table>
        </div>
      </div>

      <div className="command-panel">
        <p className="eyebrow">Bootstrap</p>
        <h2>Environment Tokens</h2>
        {machineTokens.status === "ready" ? (
          <dl className="detail-list">
            <dt>API token</dt>
            <dd>{machineTokens.data.env_tokens.api_token_present ? "present" : "missing"}</dd>
            <dt>Bot token</dt>
            <dd>{machineTokens.data.env_tokens.bot_api_token_present ? "present" : "missing"}</dd>
            <dt>Source</dt>
            <dd>{machineTokens.data.env_tokens.api_token_source}</dd>
          </dl>
        ) : (
          <p className="muted-copy">Token metadata is available to owners only.</p>
        )}
      </div>
    </section>
  );
}
