import { useId, useState } from 'react';
import { compact, monthName, naira } from '../lib/format.ts';
import { cx } from './core.tsx';

const WALLETS = '#57a4ef';
const BENEFICIARIES = '#111418';

export function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-muted">
      <span className="size-2.5 rounded-sm" style={{ background: color }} aria-hidden />
      {label}
    </span>
  );
}

interface Month {
  month: string;
  wallets: number;
  beneficiaries: number;
}

function niceMax(value: number): number {
  if (value <= 0) return 10_000_000;
  const power = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 2.5, 5, 10].map((m) => m * power).find((m) => m >= value)!;
}

/**
 * Money leaving the salary account each month: to wallets above the line, to beneficiaries below it. One scale
 * for both directions. The same figures are in a table for screen readers and for anyone who switches to it.
 */
export function FlowChart({ months }: { months: Month[] }) {
  const [active, setActive] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const id = useId();
  const width = 720;
  const height = 260;
  const left = 52;
  const bottom = 26;
  const plot = height - bottom;
  const top = 8;
  const max = niceMax(Math.max(...months.map((m) => Math.max(m.wallets, m.beneficiaries))));
  const zero = top + (plot - top) / 2;
  const scale = (zero - top - 4) / max;
  const band = (width - left) / months.length;
  const bar = Math.min(24, band * 0.5);
  const ticks = [max, max / 2, 0, -max / 2, -max];
  const hovered = active === null ? null : months[active]!;

  return (
    <div>
      <div className="mb-2 flex items-center justify-end gap-4">
        <LegendDot color={WALLETS} label="Wallets" />
        <LegendDot color={BENEFICIARIES} label="Beneficiaries" />
        <button
          type="button"
          onClick={() => setAsTable(!asTable)}
          aria-pressed={asTable}
          className="min-h-6 text-[12px] text-brand-ink hover:underline"
        >
          {asTable ? 'Show chart' : 'Show table'}
        </button>
      </div>
      {!asTable && (
        <div className="overflow-x-auto">
          <div className="relative min-w-[560px]">
            <svg
              viewBox={`0 0 ${width} ${height}`}
              className="w-full"
              role="img"
              aria-labelledby={`${id}-title`}
              onMouseLeave={() => setActive(null)}
            >
              <title id={`${id}-title`}>Monthly allocations to wallets and beneficiaries</title>
              {ticks.map((t) => {
                const y = zero - t * scale;
                return (
                  <g key={t}>
                    <line
                      x1={left}
                      x2={width}
                      y1={y}
                      y2={y}
                      stroke={t === 0 ? '#9aa5b1' : '#edf1f5'}
                      strokeWidth="1"
                    />
                    <text x={left - 8} y={y + 3.5} textAnchor="end" fontSize="10" fill="#5c6672">
                      {compact(t)}
                    </text>
                  </g>
                );
              })}
              {months.map((m, i) => {
                const x = left + i * band + (band - bar) / 2;
                const up = m.wallets * scale;
                const down = m.beneficiaries * scale;
                const r = 4;
                return (
                  <g
                    key={m.month}
                    tabIndex={0}
                    role="img"
                    aria-label={`${monthName(m.month)}: ${naira(m.wallets)} to wallets, ${naira(m.beneficiaries)} to beneficiaries`}
                    onMouseEnter={() => setActive(i)}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive(null)}
                    className="outline-none"
                  >
                    <rect
                      x={left + i * band}
                      y={top}
                      width={band}
                      height={plot - top}
                      fill={active === i ? '#f1f7fe' : 'transparent'}
                    />
                    {up > 0.5 && (
                      <path
                        d={`M${x} ${zero - 1}V${zero - up + Math.min(r, up)}q0 ${-Math.min(r, up)} ${r} ${-Math.min(r, up)}h${bar - 2 * r}q${r} 0 ${r} ${Math.min(r, up)}V${zero - 1}z`}
                        fill={WALLETS}
                      />
                    )}
                    {down > 0.5 && (
                      <path
                        d={`M${x} ${zero + 1}V${zero + down - Math.min(r, down)}q0 ${Math.min(r, down)} ${r} ${Math.min(r, down)}h${bar - 2 * r}q${r} 0 ${r} ${-Math.min(r, down)}V${zero + 1}z`}
                        fill={BENEFICIARIES}
                      />
                    )}
                    <text
                      x={left + i * band + band / 2}
                      y={height - 8}
                      textAnchor="middle"
                      fontSize="10"
                      fill="#5c6672"
                    >
                      {monthName(m.month, 'short')}
                    </text>
                  </g>
                );
              })}
            </svg>
            {hovered && (
              <div
                className="pointer-events-none absolute top-0 rounded-lg border bg-white px-3 py-2 text-[12px] shadow-md"
                style={{ left: `${Math.min(74, ((left + active! * band) / width) * 100)}%` }}
              >
                <p className="mb-1 text-muted">{monthName(hovered.month)}</p>
                <p className="num flex items-center gap-2 font-semibold">
                  <LegendDot color={WALLETS} label="" /> {naira(hovered.wallets)}
                </p>
                <p className="num flex items-center gap-2 font-semibold">
                  <LegendDot color={BENEFICIARIES} label="" /> {naira(hovered.beneficiaries)}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
      <div className={cx(!asTable && 'sr-only')}>
        <table className="w-full text-left text-[13px]">
          <caption className="sr-only">Monthly allocations</caption>
          <thead className="text-muted">
            <tr>
              <th className="py-1.5 font-normal">Month</th>
              <th className="py-1.5 text-right font-normal">Wallets</th>
              <th className="py-1.5 text-right font-normal">Beneficiaries</th>
            </tr>
          </thead>
          <tbody className="num divide-y">
            {months.map((m) => (
              <tr key={m.month}>
                <td className="py-1.5">{monthName(m.month)}</td>
                <td className="py-1.5 text-right">{naira(m.wallets)}</td>
                <td className="py-1.5 text-right">{naira(m.beneficiaries)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Share of the last salary that went to wallets and beneficiaries, with what remains in the middle. */
export function PartitionRing({
  salary,
  wallets,
  beneficiaries,
  pending,
  remaining,
}: {
  salary: number;
  wallets: number;
  beneficiaries: number;
  pending: number;
  remaining: number;
}) {
  const radius = 68;
  const circumference = 2 * Math.PI * radius;
  const parts = [
    { key: 'wallets', value: wallets, color: WALLETS },
    { key: 'beneficiaries', value: beneficiaries, color: BENEFICIARIES },
    { key: 'pending', value: pending, color: '#a9b4c0' },
  ].filter((p) => p.value > 0);
  const gap = parts.length > 1 || remaining > 0 ? 3 : 0;
  let offset = 0;
  return (
    <svg
      viewBox="0 0 180 180"
      className="mx-auto w-full max-w-[200px]"
      role="img"
      aria-label={`${naira(remaining)} of ${naira(salary)} remaining. ${naira(wallets)} to wallets, ${naira(beneficiaries)} to beneficiaries.`}
    >
      <circle cx="90" cy="90" r={radius} fill="none" stroke="#e9edf2" strokeWidth="12" />
      {salary > 0 &&
        parts.map((p) => {
          const length = (p.value / salary) * circumference;
          const element = (
            <circle
              key={p.key}
              cx="90"
              cy="90"
              r={radius}
              fill="none"
              stroke={p.color}
              strokeWidth="12"
              strokeDasharray={`${Math.max(0, length - gap)} ${circumference}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 90 90)"
            />
          );
          offset += length;
          return element;
        })}
      <text x="90" y="78" textAnchor="middle" fontSize="10" fill="#5c6672">
        Salary remaining
      </text>
      <text
        x="90"
        y="99"
        textAnchor="middle"
        fontSize={remaining >= 100_000_000_00 ? 13 : 17}
        fontWeight="600"
        fill="#111418"
      >
        {naira(remaining)}
      </text>
      <text x="90" y="116" textAnchor="middle" fontSize="10" fill="#5c6672">
        {salary > 0 ? `${Math.round((remaining / salary) * 100)}% left` : 'No salary yet'}
      </text>
    </svg>
  );
}

// Validated for colour-vision separation in this order. A seventh destination folds into "Other".
const SERIES = ['#2a78d6', '#d9480f', '#0a8f5b', '#8b5cf6', '#b8860b', '#db2777'];

export function AllocationBar({
  total,
  parts,
  remainderLabel,
}: {
  total: number;
  parts: { label: string; value: number }[];
  remainderLabel: string;
}) {
  const head = parts.slice(0, SERIES.length - (parts.length > SERIES.length ? 1 : 0));
  const rest = parts.slice(head.length).reduce((sum, p) => sum + p.value, 0);
  const shown = [...head, ...(rest > 0 ? [{ label: 'Other', value: rest }] : [])];
  const used = parts.reduce((sum, p) => sum + p.value, 0);
  return (
    <div>
      <div
        className="flex h-4 gap-0.5 overflow-hidden rounded-md bg-[#e4eaf1]"
        role="img"
        aria-label={`${total ? Math.round((used / total) * 100) : 0}% of salary allocated`}
      >
        {shown.map((p, i) => (
          <div
            key={p.label + i}
            title={`${p.label}: ${naira(p.value)}`}
            style={{ width: `${total ? (p.value / total) * 100 : 0}%`, background: SERIES[i] }}
          />
        ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
        {shown.map((p, i) => (
          <li key={p.label + i}>
            <LegendDot color={SERIES[i]!} label={`${p.label} ${naira(p.value)}`} />
          </li>
        ))}
        <li>
          <LegendDot color="#c9d2dc" label={`${remainderLabel} ${naira(Math.max(0, total - used))}`} />
        </li>
      </ul>
    </div>
  );
}

export function ProgressBar({ value, max, label }: { value: number; max: number; label: string }) {
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div>
      <div className="mb-1.5 flex justify-between text-[12px]">
        <span className="text-[#3a4450]">{label}</span>
        <span className="font-semibold">{percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        className="relative h-2.5 rounded bg-black/8"
      >
        <div className="h-full rounded bg-ink" style={{ width: `${percent}%` }} />
        <span
          aria-hidden
          className="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-ink shadow"
          style={{ left: `${Math.max(3, Math.min(97, percent))}%` }}
        />
      </div>
    </div>
  );
}
