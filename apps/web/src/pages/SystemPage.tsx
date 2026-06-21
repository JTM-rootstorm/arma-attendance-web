import { FormEvent, useState } from "react";

import { formatDate } from "../format";
import type {
  ApiResult,
  CreateMachineTokenResponse,
  MachineTokenKind,
  MachineTokenRecord,
  MachineTokenSecretResponse,
  MachineTokensResponse,
  Planet,
  PlanetsResponse,
  XpRewardTier,
  XpRewardTiersResponse
} from "../types";

const trackerConfigBaseUrl = "https://arma-stats.root-storm.com";
type SystemTab = "machineTokens" | "xpRewards" | "planets";

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

function isValidPercent(value: string): boolean {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 && /^\d{1,3}(\.\d{0,3})?$/.test(value.trim());
}

function toXpAmount(value: string): number {
  return Number(value);
}

function toPercent(value: string): string {
  return Number(value).toFixed(3);
}

export function SystemPage({
  machineTokens,
  createdToken,
  onCreateToken,
  onRevokeToken,
  onRevealToken,
  onRefresh,
  xpRewardTiers,
  planets,
  onRefreshXpRewardTiers,
  onCreateXpRewardTier,
  onUpdateXpRewardTier,
  onDeleteXpRewardTier,
  onRefreshPlanets,
  onCreatePlanet,
  onUpdatePlanet,
  onDeletePlanet
}: {
  machineTokens: ApiResult<MachineTokensResponse>;
  createdToken: CreateMachineTokenResponse | null;
  onCreateToken: (input: { name: string; token_kind: MachineTokenKind }) => Promise<void>;
  onRevokeToken: (tokenId: string) => Promise<void>;
  onRevealToken: (tokenId: string) => Promise<MachineTokenSecretResponse>;
  onRefresh: () => void;
  xpRewardTiers: ApiResult<XpRewardTiersResponse>;
  planets: ApiResult<PlanetsResponse>;
  onRefreshXpRewardTiers: () => void;
  onCreateXpRewardTier: (input: {
    mission_name_match: string;
    xp_amount: number;
    planet_progress_percent?: string;
  }) => Promise<void>;
  onUpdateXpRewardTier: (
    tierId: string,
    input: {
      mission_name_match?: string;
      xp_amount?: number;
      planet_progress_percent?: string;
    }
  ) => Promise<void>;
  onDeleteXpRewardTier: (tierId: string) => Promise<void>;
  onRefreshPlanets: () => void;
  onCreatePlanet: (input: {
    slug: string;
    name: string;
    description?: string | null;
    completion_percent: string;
    display_order: number;
    is_active: boolean;
    world_name_matches?: string[];
  }) => Promise<void>;
  onUpdatePlanet: (
    planetId: string,
    input: {
      slug?: string;
      name?: string;
      description?: string | null;
      completion_percent?: string;
      display_order?: number;
      is_active?: boolean;
      world_name_matches?: string[];
    }
  ) => Promise<void>;
  onDeletePlanet: (planetId: string) => Promise<void>;
}) {
  const [activeTab, setActiveTab] = useState<SystemTab>("machineTokens");
  const [name, setName] = useState("");
  const [tokenKind, setTokenKind] = useState<MachineTokenKind>("arma_server");
  const [visibleToken, setVisibleToken] = useState<{ record: MachineTokenRecord; token: string } | null>(null);
  const [tokenError, setTokenError] = useState("");
  const [missionNameMatch, setMissionNameMatch] = useState("");
  const [xpAmount, setXpAmount] = useState("");
  const [tierPlanetProgressPercent, setTierPlanetProgressPercent] = useState("0.000");
  const [xpError, setXpError] = useState("");
  const [editingTier, setEditingTier] = useState<{
    id: string;
    mission_name_match: string;
    xp_amount: string;
    planet_progress_percent: string;
  } | null>(null);
  const [planetSlug, setPlanetSlug] = useState("");
  const [planetName, setPlanetName] = useState("");
  const [planetDescription, setPlanetDescription] = useState("");
  const [planetCompletionPercent, setPlanetCompletionPercent] = useState("0.000");
  const [planetDisplayOrder, setPlanetDisplayOrder] = useState("0");
  const [planetWorldFilters, setPlanetWorldFilters] = useState("");
  const [planetActive, setPlanetActive] = useState(true);
  const [planetError, setPlanetError] = useState("");
  const [editingPlanet, setEditingPlanet] = useState<{
    id: string;
    slug: string;
    name: string;
    description: string;
    completion_percent: string;
    display_order: string;
    world_name_matches: string;
    is_active: boolean;
  } | null>(null);

  function parseWorldNameMatches(value: string): string[] {
    const seen = new Set<string>();
    const matches: string[] = [];

    for (const rawPart of value.split(/[\n,]+/)) {
      const match = rawPart.trim().replace(/\s+/g, " ");
      const key = match.toLowerCase();

      if (match.length === 0 || seen.has(key)) {
        continue;
      }

      seen.add(key);
      matches.push(match);
    }

    return matches;
  }

  function formatWorldNameMatches(matches: string[]): string {
    return matches.join("\n");
  }

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
        xp_amount: toXpAmount(xpAmount),
        planet_progress_percent: toPercent(tierPlanetProgressPercent)
      });
      setMissionNameMatch("");
      setXpAmount("");
      setTierPlanetProgressPercent("0.000");
    } catch (error) {
      setXpError(error instanceof Error ? error.message : "XP reward tier could not be created.");
    }
  }

  function startEditTier(tier: XpRewardTier) {
    setXpError("");
    setEditingTier({
      id: tier.id,
      mission_name_match: tier.mission_name_match,
      xp_amount: String(tier.xp_amount),
      planet_progress_percent: tier.planet_progress_percent
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
        xp_amount: toXpAmount(editingTier.xp_amount),
        planet_progress_percent: toPercent(editingTier.planet_progress_percent)
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

  async function submitPlanet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPlanetError("");

    try {
      await onCreatePlanet({
        slug: planetSlug.trim(),
        name: planetName.trim(),
        description: planetDescription.trim() || null,
        completion_percent: toPercent(planetCompletionPercent),
        display_order: Number(planetDisplayOrder),
        is_active: planetActive,
        world_name_matches: parseWorldNameMatches(planetWorldFilters)
      });
      setPlanetSlug("");
      setPlanetName("");
      setPlanetDescription("");
      setPlanetCompletionPercent("0.000");
      setPlanetDisplayOrder("0");
      setPlanetWorldFilters("");
      setPlanetActive(true);
    } catch (error) {
      setPlanetError(error instanceof Error ? error.message : "Planet could not be created.");
    }
  }

  function startEditPlanet(planet: Planet) {
    setPlanetError("");
    setEditingPlanet({
      id: planet.id,
      slug: planet.slug,
      name: planet.name,
      description: planet.description ?? "",
      completion_percent: planet.completion_percent,
      display_order: String(planet.display_order),
      world_name_matches: formatWorldNameMatches(planet.world_name_matches),
      is_active: planet.is_active
    });
  }

  async function saveEditPlanet() {
    if (!editingPlanet) {
      return;
    }

    setPlanetError("");

    try {
      await onUpdatePlanet(editingPlanet.id, {
        slug: editingPlanet.slug.trim(),
        name: editingPlanet.name.trim(),
        description: editingPlanet.description.trim() || null,
        completion_percent: toPercent(editingPlanet.completion_percent),
        display_order: Number(editingPlanet.display_order),
        world_name_matches: parseWorldNameMatches(editingPlanet.world_name_matches),
        is_active: editingPlanet.is_active
      });
      setEditingPlanet(null);
    } catch (error) {
      setPlanetError(error instanceof Error ? error.message : "Planet could not be updated.");
    }
  }

  async function deletePlanet(planet: Planet) {
    if (!window.confirm(`Deactivate ${planet.name}?`)) {
      return;
    }

    setPlanetError("");

    try {
      await onDeletePlanet(planet.id);
      if (editingPlanet?.id === planet.id) {
        setEditingPlanet(null);
      }
    } catch (error) {
      setPlanetError(error instanceof Error ? error.message : "Planet could not be deactivated.");
    }
  }

  const createXpDisabled =
    missionNameMatch.trim().length === 0 || !isValidXpAmount(xpAmount) || !isValidPercent(tierPlanetProgressPercent);
  const saveXpDisabled =
    !editingTier ||
    editingTier.mission_name_match.trim().length === 0 ||
    !isValidXpAmount(editingTier.xp_amount) ||
    !isValidPercent(editingTier.planet_progress_percent);
  const createPlanetDisabled =
    planetSlug.trim().length === 0 ||
    planetName.trim().length === 0 ||
    !isValidPercent(planetCompletionPercent) ||
    !Number.isInteger(Number(planetDisplayOrder));
  const savePlanetDisabled =
    !editingPlanet ||
    editingPlanet.slug.trim().length === 0 ||
    editingPlanet.name.trim().length === 0 ||
    !isValidPercent(editingPlanet.completion_percent) ||
    !Number.isInteger(Number(editingPlanet.display_order));

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
        <button
          type="button"
          className={activeTab === "planets" ? "active" : undefined}
          aria-pressed={activeTab === "planets"}
          onClick={() => setActiveTab("planets")}
        >
          Planet Management
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
      ) : activeTab === "xpRewards" ? (
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
            Configure automatic player XP and global planet progress by standardized TCW mission name. Enter a full mission name or a partial substring.
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
            <input
              type="number"
              min="0"
              max="100"
              step="0.001"
              value={tierPlanetProgressPercent}
              onChange={(event) => setTierPlanetProgressPercent(event.target.value)}
              placeholder="Planet progress %"
              aria-label="Planet progress percent"
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
                  <th>Global Planet Progress</th>
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
                        <td>
                          {isEditing && editingTier ? (
                            <input
                              type="number"
                              min="0"
                              max="100"
                              step="0.001"
                              value={editingTier.planet_progress_percent}
                              onChange={(event) => setEditingTier({ ...editingTier, planet_progress_percent: event.target.value })}
                              aria-label="Edit planet progress percent"
                            />
                          ) : (
                            Number(tier.planet_progress_percent).toFixed(3)
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
                    <td colSpan={5}>{xpRewardTiers.status === "loading" ? "Loading XP reward tiers." : "No XP reward tiers configured yet."}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="command-panel wide">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Campaign progress</p>
              <h2>Planet Management</h2>
            </div>
            <button type="button" onClick={onRefreshPlanets}>
              Refresh
            </button>
          </div>

          {planets.status === "error" ? <p className="error-line">{planets.error}</p> : null}
          {planetError ? <p className="error-line">{planetError}</p> : null}

          <form className="inline-form xp-tier-form" onSubmit={(event) => void submitPlanet(event)}>
            <input value={planetSlug} onChange={(event) => setPlanetSlug(event.target.value)} placeholder="slug" aria-label="Planet slug" />
            <input value={planetName} onChange={(event) => setPlanetName(event.target.value)} placeholder="Name" aria-label="Planet name" />
            <input
              value={planetDescription}
              onChange={(event) => setPlanetDescription(event.target.value)}
              placeholder="Description"
              aria-label="Planet description"
            />
            <input
              type="number"
              min="0"
              max="100"
              step="0.001"
              value={planetCompletionPercent}
              onChange={(event) => setPlanetCompletionPercent(event.target.value)}
              placeholder="Completion %"
              aria-label="Planet completion percent"
            />
            <input
              type="number"
              step="1"
              value={planetDisplayOrder}
              onChange={(event) => setPlanetDisplayOrder(event.target.value)}
              placeholder="Order"
              aria-label="Planet display order"
            />
            <textarea
              rows={2}
              value={planetWorldFilters}
              onChange={(event) => setPlanetWorldFilters(event.target.value)}
              placeholder="World filters"
              aria-label="Planet world filters"
            />
            <label className="checkbox-control">
              <input type="checkbox" checked={planetActive} onChange={(event) => setPlanetActive(event.target.checked)} />
              <span>Active</span>
            </label>
            <button type="submit" disabled={createPlanetDisabled}>
              Add Planet
            </button>
          </form>

          <div className="tactical-table">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Slug</th>
                  <th>Completion</th>
                  <th>World Filters</th>
                  <th>Active</th>
                  <th>Updated</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {planets.status === "ready" && planets.data.planets.length > 0 ? (
                  planets.data.planets.map((planet) => {
                    const isEditing = editingPlanet?.id === planet.id;

                    return (
                      <tr key={planet.id}>
                        <td>
                          {isEditing && editingPlanet ? (
                            <input
                              value={editingPlanet.name}
                              onChange={(event) => setEditingPlanet({ ...editingPlanet, name: event.target.value })}
                              aria-label="Edit planet name"
                            />
                          ) : (
                            planet.name
                          )}
                        </td>
                        <td>
                          {isEditing && editingPlanet ? (
                            <input
                              value={editingPlanet.slug}
                              onChange={(event) => setEditingPlanet({ ...editingPlanet, slug: event.target.value })}
                              aria-label="Edit planet slug"
                            />
                          ) : (
                            planet.slug
                          )}
                        </td>
                        <td>
                          {isEditing && editingPlanet ? (
                            <input
                              type="number"
                              min="0"
                              max="100"
                              step="0.001"
                              value={editingPlanet.completion_percent}
                              onChange={(event) => setEditingPlanet({ ...editingPlanet, completion_percent: event.target.value })}
                              aria-label="Edit completion percent"
                            />
                          ) : (
                            Number(planet.completion_percent).toFixed(3)
                          )}
                        </td>
                        <td>
                          {isEditing && editingPlanet ? (
                            <textarea
                              rows={2}
                              value={editingPlanet.world_name_matches}
                              onChange={(event) => setEditingPlanet({ ...editingPlanet, world_name_matches: event.target.value })}
                              aria-label="Edit planet world filters"
                            />
                          ) : planet.world_name_matches.length > 0 ? (
                            planet.world_name_matches.join(", ")
                          ) : (
                            "None"
                          )}
                        </td>
                        <td>
                          {isEditing && editingPlanet ? (
                            <label className="checkbox-control compact">
                              <input
                                type="checkbox"
                                checked={editingPlanet.is_active}
                                onChange={(event) => setEditingPlanet({ ...editingPlanet, is_active: event.target.checked })}
                              />
                              <span>{editingPlanet.is_active ? "active" : "inactive"}</span>
                            </label>
                          ) : planet.is_active ? (
                            "active"
                          ) : (
                            "inactive"
                          )}
                        </td>
                        <td>{formatDate(planet.updated_at)}</td>
                        <td className="table-actions">
                          {isEditing ? (
                            <>
                              <button type="button" className="secondary" onClick={() => void saveEditPlanet()} disabled={savePlanetDisabled}>
                                Save
                              </button>
                              <button type="button" className="secondary" onClick={() => setEditingPlanet(null)}>
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button type="button" className="secondary" onClick={() => startEditPlanet(planet)}>
                              Edit
                            </button>
                          )}
                          <button type="button" className="danger" onClick={() => void deletePlanet(planet)}>
                            Deactivate
                          </button>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={7}>{planets.status === "loading" ? "Loading planets." : "No planets configured yet."}</td>
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
