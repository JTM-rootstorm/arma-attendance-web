import type { OperationStatus } from "../types";

type StatusTone = "ready" | "info" | "warn" | "danger" | "muted" | "active";

const operationTone: Record<OperationStatus, StatusTone> = {
  finished: "ready",
  failed: "danger",
  started: "active",
  abandoned: "danger"
};

export function StatusChip({
  label,
  tone = "muted",
  pulse = false
}: {
  label: string;
  tone?: StatusTone;
  pulse?: boolean;
}) {
  return <span className={`status-chip ${tone}${pulse ? " pulse" : ""}`}>{label}</span>;
}

export function OperationStatusChip({ status }: { status: OperationStatus }) {
  return <StatusChip label={status} tone={operationTone[status]} pulse={status === "started"} />;
}
