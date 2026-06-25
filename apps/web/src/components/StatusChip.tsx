import type { OperationStatus } from "../types";

type StatusTone = "ready" | "info" | "warn" | "danger" | "muted" | "active";

const operationLifecycleTone: Record<OperationStatus, StatusTone> = {
  finished: "ready",
  failed: "ready",
  started: "active",
  abandoned: "danger"
};

function operationLifecycleLabel(status: OperationStatus): string {
  return status === "failed" ? "finished" : status;
}

function operationOutcome(status: OperationStatus): { label: string; tone: StatusTone } | null {
  if (status === "finished") {
    return { label: "mission success", tone: "ready" };
  }

  if (status === "failed") {
    return { label: "mission failed", tone: "danger" };
  }

  return null;
}

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
  return <OperationLifecycleChip status={status} />;
}

export function OperationLifecycleChip({ status }: { status: OperationStatus }) {
  return <StatusChip label={operationLifecycleLabel(status)} tone={operationLifecycleTone[status]} pulse={status === "started"} />;
}

export function OperationOutcomeChip({ status }: { status: OperationStatus }) {
  const outcome = operationOutcome(status);

  if (!outcome) {
    return <StatusChip label={status === "started" ? "pending" : "not completed"} tone="muted" />;
  }

  return <StatusChip label={outcome.label} tone={outcome.tone} />;
}

export function OperationStatusPair({ status }: { status: OperationStatus }) {
  const outcome = operationOutcome(status);

  return (
    <span className="status-pair">
      <OperationLifecycleChip status={status} />
      {outcome ? <StatusChip label={outcome.label} tone={outcome.tone} /> : null}
    </span>
  );
}
