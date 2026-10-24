import type { Stats } from "../lib/types";

/** Stacked ok/failed bars per time bucket. Plain SVG: no chart library to ship or audit. */
export function Bars({ series, bucket }: { series: Stats["series"]; bucket: string }) {
  const max = Math.max(1, ...series.map((s) => s.ok + s.failed));
  const w = 100 / Math.max(series.length, 24); // fixed slot width so a sparse window does not produce a few huge bars
  if (series.length === 0) return <p className="py-10 text-center text-sm text-muted">No calls in this window yet.</p>;
  const label = (iso: string) => new Date(iso).toLocaleString(undefined, bucket === "1 day" ? { month: "short", day: "numeric" } : { hour: "numeric", minute: "2-digit" });
  return (
    <figure>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-40 w-full" role="img" aria-label={`Tool calls per ${bucket}`}>
        {series.map((s, i) => {
          const okH = (s.ok / max) * 38;
          const badH = (s.failed / max) * 38;
          return (
            <g key={s.bucket}>
              <title>{`${label(s.bucket)}: ${s.ok} ok, ${s.failed} failed`}</title>
              <rect x={i * w + w * 0.12} width={w * 0.76} y={39 - okH} height={okH} fill="var(--ink)" />
              <rect x={i * w + w * 0.12} width={w * 0.76} y={39 - okH - badH} height={badH} fill="var(--bad)" />
            </g>
          );
        })}
        <line x1="0" x2="100" y1="39.5" y2="39.5" stroke="var(--line)" strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="mt-1 flex justify-between text-xs text-muted">
        <span>{label(series[0]!.bucket)}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1"><i className="inline-block size-2 bg-ink" />succeeded</span>
          <span className="flex items-center gap-1"><i className="inline-block size-2 bg-bad" />failed</span>
        </span>
        <span>{label(series.at(-1)!.bucket)}</span>
      </figcaption>
    </figure>
  );
}
