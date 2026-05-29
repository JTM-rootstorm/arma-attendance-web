import { displayValue } from "../format";

export function MetricTile({
  label,
  value,
  detail
}: {
  label: string;
  value: string | number | null | undefined;
  detail?: string;
}) {
  return (
    <div className="metric-tile">
      <span>{label}</span>
      <strong>{displayValue(value)}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}
