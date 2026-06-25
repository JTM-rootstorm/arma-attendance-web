#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

type AllowlistEntry = {
  pattern: RegExp;
  category: string;
  reason: string;
};

type BoundaryFinding = {
  file: string;
  line: number;
  match: string;
  reason: string;
};

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const allowedRawSqlFiles: AllowlistEntry[] = [
  {
    pattern: /^apps\/api\/src\/db\/pool\.ts$/,
    category: "db plumbing",
    reason: "central pg pool wrapper"
  },
  {
    pattern: /^apps\/api\/src\/db\/transactions\.ts$/,
    category: "db plumbing",
    reason: "central transaction wrapper"
  },
  {
    pattern: /^apps\/api\/src\/routes\/operations\.ts$/,
    category: "operation routes",
    reason: "operation route registrar"
  },
  {
    pattern: /^apps\/api\/src\/operations\/.*\.ts$/,
    category: "operation services",
    reason: "operation ingest, idempotency, payloads, delete cascade, XP rollback, and detail aggregates"
  },
  {
    pattern: /^apps\/api\/src\/routes\/ingestRequests\.ts$/,
    category: "operation ingest",
    reason: "ingest request observability"
  },
  {
    pattern: /^apps\/api\/src\/routes\/summaries\.ts$/,
    category: "reporting",
    reason: "dashboard aggregates and player summary projections"
  },
  {
    pattern: /^apps\/api\/src\/routes\/leaderboards\.ts$/,
    category: "reporting",
    reason: "leaderboard CTEs and ranking aggregates"
  },
  {
    pattern: /^apps\/api\/src\/routes\/exports\.ts$/,
    category: "reporting",
    reason: "CSV export queries"
  },
  {
    pattern: /^apps\/api\/src\/routes\/dataQuality\.ts$/,
    category: "reporting",
    reason: "data quality aggregate checks"
  },
  {
    pattern: /^apps\/api\/src\/routes\/healthDb\.ts$/,
    category: "health",
    reason: "database readiness probe"
  },
  {
    pattern: /^apps\/api\/src\/routes\/players\.ts$/,
    category: "reporting",
    reason: "player list/detail aggregate projections"
  },
  {
    pattern: /^apps\/api\/src\/routes\/units\.ts$/,
    category: "unit hybrid",
    reason: "Drizzle route with limited raw SQL for counts, CTE hierarchy operations, and aggregate checks"
  },
  {
    pattern: /^apps\/api\/src\/routes\/discord\.ts$/,
    category: "discord hybrid",
    reason: "Discord route registrar"
  },
  {
    pattern: /^apps\/api\/src\/routes\/discord\/.*\.ts$/,
    category: "discord hybrid",
    reason: "Discord admin CRUD, sync, role action, and audit route modules"
  },
  {
    pattern: /^apps\/api\/src\/routes\/auth\.ts$/,
    category: "auth/session bridge",
    reason: "OAuth and synthetic auth bridge with provider-state, self-stat aggregates, and audit transactions"
  },
  {
    pattern: /^apps\/api\/src\/auth\/jwt\.ts$/,
    category: "auth/session bridge",
    reason: "JWT handoff and refresh-token transaction bridge"
  },
  {
    pattern: /^apps\/api\/src\/routes\/admin\.ts$/,
    category: "admin/user search",
    reason: "admin multi-filter search, role transactions, audit writes, and player-name reset projections"
  },
  {
    pattern: /^apps\/api\/src\/auth\/csrf\.ts$/,
    category: "auth/session bridge",
    reason: "CSRF token compatibility path"
  },
  {
    pattern: /^apps\/api\/src\/auth\/operationAccess\.ts$/,
    category: "auth/session bridge",
    reason: "operation visibility bridge joining identities to attendance"
  },
  {
    pattern: /^apps\/api\/src\/identity\/playerCanonicalization\.ts$/,
    category: "identity merge",
    reason: "Discord placeholder player canonicalization moves related rows across identity, unit, operation, and audit tables"
  },
  {
    pattern: /^apps\/api\/src\/normalization\/operationAttendance\.ts$/,
    category: "normalization",
    reason: "attendance/stat upserts"
  },
  {
    pattern: /^apps\/api\/src\/normalization\/operationUnits\.ts$/,
    category: "normalization",
    reason: "operation-player unit attribution from represented unit snapshots and primary operation fallback"
  },
  {
    pattern: /^apps\/api\/src\/xp\/operationXpAwards\.ts$/,
    category: "operation ingest",
    reason: "finish-time XP award ledger and aggregate update transaction"
  },
  {
    pattern: /^apps\/api\/src\/discord\/scoring\.ts$/,
    category: "discord scoring",
    reason: "role evaluation CTEs and action audit reporting"
  },
  {
    pattern: /^apps\/api\/src\/discord\/membershipResolver\.ts$/,
    category: "discord auth sync",
    reason: "Discord guild role claim resolution and assignment reconciliation"
  },
  {
    pattern: /^apps\/api\/src\/scripts\/backfillAttendance\.ts$/,
    category: "backfill",
    reason: "maintenance backfill"
  },
  {
    pattern: /^apps\/api\/src\/scripts\/backfillScoreboardStats\.ts$/,
    category: "backfill",
    reason: "maintenance backfill"
  },
  {
    pattern: /^apps\/api\/src\/scripts\/backfillUnits\.ts$/,
    category: "backfill",
    reason: "maintenance backfill"
  },
  {
    pattern: /^scripts\/admin-(grant|list)\.ts$/,
    category: "admin cli",
    reason: "local administrative maintenance CLI"
  },
  {
    pattern: /^scripts\/db-(migrate|status)\.sh$/,
    category: "migration/deploy",
    reason: "SQL migration runner"
  },
  {
    pattern: /^scripts\/.*smoke.*\.sh$/,
    category: "smoke tests",
    reason: "synthetic setup and assertions"
  }
];

const scanRoots = ["apps/api/src", "scripts"];
const skippedPathParts = new Set(["node_modules", "dist", ".git"]);
const skippedPaths = new Set([
  "apps/api/dist",
  "apps/web/dist",
  "sql/migrations",
  "sql/drizzle",
  "scripts/drizzle-boundary-check.ts"
]);

const rawSqlIndicators = [
  /queryDb\s*\(/,
  /\btx\.query\s*\(/,
  /\.query\s*\(/,
  /\bpsql\b/,
  /\bFROM\s+[A-Za-z_][A-Za-z0-9_]*(?:\s|$)/,
  /\bINSERT\s+INTO\s+[A-Za-z_][A-Za-z0-9_]*(?:\s|$|\()/,
  /\bUPDATE\s+[A-Za-z_][A-Za-z0-9_]*(?:\s|$)/,
  /\bDELETE\s+FROM\s+[A-Za-z_][A-Za-z0-9_]*(?:\s|$)/,
  /\bCREATE\s+TABLE\s+/,
  /\bALTER\s+TABLE\s+/
];

function toRepoPath(path: string): string {
  return relative(repoRoot, path).split(sep).join("/");
}

function isSkipped(path: string): boolean {
  const repoPath = toRepoPath(path);
  if (skippedPaths.has(repoPath)) {
    return true;
  }

  return repoPath.split("/").some((part) => skippedPathParts.has(part));
}

function collectFiles(root: string): string[] {
  const absoluteRoot = join(repoRoot, root);
  if (!existsSync(absoluteRoot)) {
    return [];
  }

  const results: string[] = [];
  const entries = readdirSync(absoluteRoot);

  for (const entry of entries) {
    const absolutePath = join(absoluteRoot, entry);
    if (isSkipped(absolutePath)) {
      continue;
    }

    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      results.push(...collectFiles(toRepoPath(absolutePath)));
      continue;
    }

    if (/\.(ts|sh)$/.test(entry)) {
      results.push(absolutePath);
    }
  }

  return results;
}

function findAllowlistEntry(file: string): AllowlistEntry | null {
  return allowedRawSqlFiles.find((entry) => entry.pattern.test(file)) ?? null;
}

function findGeneratedDrizzleOutput(): BoundaryFinding[] {
  const findings: BoundaryFinding[] = [];

  try {
    const tracked = execFileSync("git", ["ls-files", "sql/drizzle"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    for (const file of tracked) {
      findings.push({
        file,
        line: 1,
        match: "tracked sql/drizzle output",
        reason: "generated Drizzle migration output must not be committed"
      });
    }
  } catch {
    // If git is unavailable, the scan below still catches raw SQL boundary drift.
  }

  try {
    const staged = execFileSync("git", ["diff", "--cached", "--name-only", "--", "sql/drizzle"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    for (const file of staged) {
      findings.push({
        file,
        line: 1,
        match: "staged sql/drizzle output",
        reason: "generated Drizzle migration output must not be staged"
      });
    }
  } catch {
    // Ignore git errors here; release validation still runs in a git checkout.
  }

  return findings;
}

function findRawSqlBoundaryViolations(): BoundaryFinding[] {
  const findings: BoundaryFinding[] = [];
  const files = scanRoots.flatMap(collectFiles);

  for (const absolutePath of files) {
    const repoPath = toRepoPath(absolutePath);
    const content = readSafeFile(absolutePath);

    if (!content) {
      continue;
    }

    const allowlistEntry = findAllowlistEntry(repoPath);
    const lines = content.split("\n");

    lines.forEach((line, index) => {
      for (const indicator of rawSqlIndicators) {
        const match = line.match(indicator);
        if (!match) {
          continue;
        }

        if (!allowlistEntry) {
          findings.push({
            file: repoPath,
            line: index + 1,
            match: match[0],
            reason: "file is not allowlisted"
          });
        }

        break;
      }
    });
  }

  return findings;
}

function readSafeFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

const findings = [...findGeneratedDrizzleOutput(), ...findRawSqlBoundaryViolations()];

if (findings.length > 0) {
  console.error("[drizzle:boundary] Raw SQL usage outside approved boundary:");
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line} matched "${finding.match}"`);
    console.error(`  reason: ${finding.reason}`);
  }
  process.exit(1);
}

console.log("[drizzle:boundary] OK: raw SQL usage is limited to approved boundary files.");
