import { FormEvent, useState } from "react";

import type {
  ApiResult,
  CreateMachineTokenResponse,
  MachineTokenKind,
  MachineTokenRecord,
  MachineTokenSecretResponse,
  MachineTokensResponse
} from "../types";

const trackerConfigBaseUrl = "https://arma-stats.root-storm.com";

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function buildTrackerConfig(tokenName: string, apiToken: string): string {
  return `# TCWA3 Stats Tracker server extension config template.
# Copy this file to tcwa3_stats_tracker.toml beside the server extension binary before editing it.
# Never commit the real tcwa3_stats_tracker.toml.

[server]
server_key = ${tomlString(tokenName)}

[http]
base_url = ${tomlString(trackerConfigBaseUrl)}
api_token = ${tomlString(apiToken)}
timeout_ms = 5000
verify_tls = true

[logging]
level = "info"

[queue]
enabled = true
queue_file = "tcwa3_stats_tracker_queue.ndjson"
queue_sent_file = "tcwa3_stats_tracker_queue.sent.ndjson"
max_attempts = 25
`;
}

function downloadTextFile(filename: string, text: string) {
  const blob = new Blob([text], { type: "application/toml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function SystemPage({
  machineTokens,
  createdToken,
  onCreateToken,
  onRevokeToken,
  onRevealToken,
  onRefresh
}: {
  machineTokens: ApiResult<MachineTokensResponse>;
  createdToken: CreateMachineTokenResponse | null;
  onCreateToken: (input: { name: string; token_kind: MachineTokenKind }) => Promise<void>;
  onRevokeToken: (tokenId: string) => Promise<void>;
  onRevealToken: (tokenId: string) => Promise<MachineTokenSecretResponse>;
  onRefresh: () => void;
}) {
  const [name, setName] = useState("");
  const [tokenKind, setTokenKind] = useState<MachineTokenKind>("arma_server");
  const [visibleToken, setVisibleToken] = useState<{ record: MachineTokenRecord; token: string } | null>(null);
  const [tokenError, setTokenError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onCreateToken({ name: name.trim(), token_kind: tokenKind });
    setName("");
  }

  async function revealToken(tokenId: string) {
    setTokenError("");

    try {
      const response = await onRevealToken(tokenId);
      setVisibleToken({ record: response.token_record, token: response.token });
    } catch (error) {
      setTokenError(error instanceof Error ? error.message : "Machine token could not be viewed.");
    }
  }

  async function downloadConfig(tokenId: string) {
    setTokenError("");

    try {
      const response = await onRevealToken(tokenId);
      downloadTextFile("tcwa3_stats_tracker.toml", buildTrackerConfig(response.token_record.name, response.token));
    } catch (error) {
      setTokenError(error instanceof Error ? error.message : "Machine token config could not be downloaded.");
    }
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
            <span>New token ready</span>
            <p>Use the row actions to download the TCWA3 config or view the token fallback.</p>
          </div>
        ) : null}
        {tokenError ? <p className="error-line">{tokenError}</p> : null}

        <form className="inline-form" onSubmit={(event) => void submit(event)}>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Token name" />
          <select value={tokenKind} onChange={(event) => setTokenKind(event.target.value as MachineTokenKind)}>
            <option value="arma_server">Arma server</option>
            <option value="bot">Discord bot</option>
            <option value="api">API automation</option>
            <option value="base44_integration">Base44 integration</option>
          </select>
          <button type="submit" disabled={name.trim().length === 0}>
            Create
          </button>
        </form>
        <p className="muted-copy">
          Base44 integration tokens are for server-side Base44 automations only. Do not paste this token into browser/client-side code.
        </p>

        <div className="tactical-table">
          <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kind</th>
                  <th>Prefix</th>
                  <th>Status</th>
                  <th>Last Used</th>
                  <th>Actions</th>
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
                      <td className="table-actions">
                        {token.is_active && !token.revoked_at ? (
                          <>
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => void downloadConfig(token.id)}
                              disabled={!token.token_available}
                              title={token.token_available ? "Download tcwa3_stats_tracker.toml" : "Token secret is unavailable for this legacy entry"}
                            >
                              Download
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => void revealToken(token.id)}
                              disabled={!token.token_available}
                              title={token.token_available ? "View token fallback" : "Token secret is unavailable for this legacy entry"}
                            >
                              View
                            </button>
                            <button type="button" className="danger" onClick={() => void onRevokeToken(token.id)}>
                              Delete
                            </button>
                          </>
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

      {visibleToken ? (
        <div className="modal-backdrop" role="presentation">
          <section className="confirm-dialog token-dialog" role="dialog" aria-modal="true" aria-labelledby="machine-token-title">
            <div>
              <p className="eyebrow">Machine token fallback</p>
              <h3 id="machine-token-title">{visibleToken.record.name}</h3>
            </div>
            <p className="confirm-subtext">Use download for normal server setup. This view exposes the token until closed.</p>
            <code className="revealed-token">{visibleToken.token}</code>
            <div className="confirm-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => downloadTextFile("tcwa3_stats_tracker.toml", buildTrackerConfig(visibleToken.record.name, visibleToken.token))}
              >
                Download
              </button>
              <button type="button" onClick={() => setVisibleToken(null)}>
                Close
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
