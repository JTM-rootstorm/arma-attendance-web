import { FormEvent, useState } from "react";

import { formatDate } from "../format";
import type {
  ApiResult,
  CreateMachineTokenResponse,
  MachineTokenKind,
  MachineTokenRecord,
  MachineTokenSecretResponse,
  MachineTokensResponse,
  XpRewardTier,
  XpRewardTiersResponse
} from "../types";

const trackerConfigBaseUrl = "https://arma-stats.root-storm.com";
type SystemTab = "machineTokens" | "xpRewards";

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

function isValidXpAmount(value: string): boolean {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 1_000_000;
}

function toXpAmount(value: string): number {
  return Number(value);
}

export function SystemPage({
  machineTokens,
  createdToken,
  onCreateToken,
  onRevokeToken,
  onRevealToken,
  onRefresh,
  xpRewardTiers,
  onRefreshXpRewardTiers,
  onCreateXpRewardTier,
  onUpdateXpRewardTier,
  onDeleteXpRewardTier
}: {
  machineTokens: ApiResult<MachineTokensResponse>;
  createdToken: CreateMachineTokenResponse | null;
  onCreateToken: (input: { name: string; token_kind: MachineTokenKind }) => Promise<void>;
  onRevokeToken: (tokenId: string) => Promise<void>;
  onRevealToken: (tokenId: string) => Promise<MachineTokenSecretResponse>;
  onRefresh: () => void;
  xpRewardTiers: ApiResult<XpRewardTiersResponse>;
  onRefreshXpRewardTiers: () => void;
  onCreateXpRewardTier: (input: { mission_name_match: string; xp_amount: number }) => Promise<void>;
  onUpdateXpRewardTier: (tierId: string, input: { mission_name_match?: string; xp_amount?: number }) => Promise<void>;
  onDeleteXpRewardTier: (tierId: string) => Promise<void>;
}) {
  const [activeTab, setActiveTab] = useState<SystemTab>("machineTokens");
  const [name, setName] = useState("");
  const [tokenKind, setTokenKind] = useState<MachineTokenKind>("arma_server");
  const [visibleToken, setVisibleToken] = useState<{ record: MachineTokenRecord; token: string } | null>(null);
  const [tokenError, setTokenError] = useState("");
  const [missionNameMatch, setMissionNameMatch] = useState("");
  const [xpAmount, setXpAmount] = useState("");
  const [xpError, setXpError] = useState("");
  const [editingTier, setEditingTier] = useState<{ id: string; mission_name_match: string; xp_amount: string } | null>(null);

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

  async function submitXpTier(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setXpError("");

    try {
      await onCreateXpRewardTier({
        mission_name_match: missionNameMatch.trim(),
        xp_amount: toXpAmount(xpAmount)
      });
      setMissionNameMatch("");
      setXpAmount("");
    } catch (error) {
      setXpError(error instanceof Error ? error.message : "XP reward tier could not be created.");
    }
  }

  function startEditTier(tier: XpRewardTier) {
    setXpError("");
    setEditingTier({
      id: tier.id,
      mission_name_match: tier.mission_name_match,
      xp_amount: String(tier.xp_amount)
    });
  }

  async function saveEditTier() {
    if (!editingTier) {
      return;
    }

    setXpError("");

    try {
      await onUpdateXpRewardTier(editingTier.id, {
        mission_name_match: editingTier.mission_name_match.trim(),
        xp_amount: toXpAmount(editingTier.xp_amount)
      });
      setEditingTier(null);
    } catch (error) {
      setXpError(error instanceof Error ? error.message : "XP reward tier could not be updated.");
    }
  }

  async function deleteXpTier(tier: XpRewardTier) {
    if (!window.confirm(`Delete XP reward tier for ${tier.mission_name_match}?`)) {
      return;
    }

    setXpError("");

    try {
      await onDeleteXpRewardTier(tier.id);
      if (editingTier?.id === tier.id) {
        setEditingTier(null);
      }
    } catch (error) {
      setXpError(error instanceof Error ? error.message : "XP reward tier could not be deleted.");
    }
  }

  const createXpDisabled = missionNameMatch.trim().length === 0 || !isValidXpAmount(xpAmount);
  const saveXpDisabled = !editingTier || editingTier.mission_name_match.trim().length === 0 || !isValidXpAmount(editingTier.xp_amount);

  return (
    <section className="view-grid system-grid">
      <div className="system-tabs" aria-label="System sections">
        <button
          type="button"
          className={activeTab === "machineTokens" ? "active" : undefined}
          aria-pressed={activeTab === "machineTokens"}
          onClick={() => setActiveTab("machineTokens")}
        >
          Machine Tokens
        </button>
        <button
          type="button"
          className={activeTab === "xpRewards" ? "active" : undefined}
          aria-pressed={activeTab === "xpRewards"}
          onClick={() => setActiveTab("xpRewards")}
        >
          XP Rewards
        </button>
      </div>

      {activeTab === "machineTokens" ? (
        <>
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
        </>
      ) : (
        <div className="command-panel wide">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Mission reward framework</p>
              <h2>XP Reward Tiers</h2>
            </div>
            <button type="button" onClick={onRefreshXpRewardTiers}>
              Refresh
            </button>
          </div>

          <p className="muted-copy">
            Configure XP rewards by standardized TCW mission name. Enter a full mission name or a partial substring. These rows are not used for automatic XP awards yet.
          </p>

          {xpRewardTiers.status === "error" ? <p className="error-line">{xpRewardTiers.error}</p> : null}
          {xpError ? <p className="error-line">{xpError}</p> : null}

          <form className="inline-form xp-tier-form" onSubmit={(event) => void submitXpTier(event)}>
            <input
              value={missionNameMatch}
              onChange={(event) => setMissionNameMatch(event.target.value)}
              placeholder="Mission name match"
              aria-label="Mission name match"
            />
            <input
              type="number"
              min="1"
              max="1000000"
              step="1"
              value={xpAmount}
              onChange={(event) => setXpAmount(event.target.value)}
              placeholder="XP amount"
              aria-label="XP amount"
            />
            <button type="submit" disabled={createXpDisabled}>
              Add Tier
            </button>
          </form>

          <div className="tactical-table">
            <table>
              <thead>
                <tr>
                  <th>Mission Name Match</th>
                  <th>XP</th>
                  <th>Updated</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {xpRewardTiers.status === "ready" && xpRewardTiers.data.tiers.length > 0 ? (
                  xpRewardTiers.data.tiers.map((tier) => {
                    const isEditing = editingTier?.id === tier.id;

                    return (
                      <tr key={tier.id}>
                        <td>
                          {isEditing && editingTier ? (
                            <input
                              value={editingTier.mission_name_match}
                              onChange={(event) => setEditingTier({ ...editingTier, mission_name_match: event.target.value })}
                              aria-label="Edit mission name match"
                            />
                          ) : (
                            tier.mission_name_match
                          )}
                        </td>
                        <td>
                          {isEditing && editingTier ? (
                            <input
                              type="number"
                              min="1"
                              max="1000000"
                              step="1"
                              value={editingTier.xp_amount}
                              onChange={(event) => setEditingTier({ ...editingTier, xp_amount: event.target.value })}
                              aria-label="Edit XP amount"
                            />
                          ) : (
                            tier.xp_amount
                          )}
                        </td>
                        <td>{formatDate(tier.updated_at)}</td>
                        <td className="table-actions">
                          {isEditing ? (
                            <>
                              <button type="button" className="secondary" onClick={() => void saveEditTier()} disabled={saveXpDisabled}>
                                Save
                              </button>
                              <button type="button" className="secondary" onClick={() => setEditingTier(null)}>
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button type="button" className="secondary" onClick={() => startEditTier(tier)}>
                              Edit
                            </button>
                          )}
                          <button type="button" className="danger" onClick={() => void deleteXpTier(tier)}>
                            Delete
                          </button>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={4}>{xpRewardTiers.status === "loading" ? "Loading XP reward tiers." : "No XP reward tiers configured yet."}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

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
