'use client';

import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

/**
 * Checked with the dataviz palette validator against the white card:
 *   node validate_palette.js "#DAA00B,#0D9488" --mode light --surface "#ffffff"
 * The app's --chart-2 teal reads gray (below the chroma floor), so collected
 * uses a stronger step of the same hue. Gold is under 3:1 against white, which
 * is why the chart always ships with its table view.
 */
const SERIES = [
  { key: 'disbursed', name: 'Disbursed', color: '#DAA00B' },
  { key: 'collected', name: 'Collected', color: '#0D9488' },
] as const;

export interface TrendChartPoint {
  label: string;
  disbursed: number;
  collected: number;
}

function compact(value: number) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return String(value);
}

function TrendTooltip({
  active,
  payload,
  label,
  currency,
}: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
  currency: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-medium text-popover-foreground">{label}</p>
      {payload.map((entry) => (
        <p key={entry.name} className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: entry.color }} />
          <span className="text-muted-foreground">{entry.name}</span>
          <span className="num ml-auto pl-3 font-medium text-popover-foreground">
            {currency} {entry.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </p>
      ))}
    </div>
  );
}

export function TrendChart({ data, currency }: { data: TrendChartPoint[]; currency: string }) {
  // Markers only while there are few enough points to read them; a lone point needs one to show at all.
  const showDots = data.length <= 14;
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={{ stroke: 'hsl(var(--border))' }}
            fontSize={11}
            minTickGap={16}
            tick={{ fill: 'hsl(var(--muted-foreground))' }}
          />
          <YAxis tickLine={false} axisLine={false} fontSize={11} width={52} tickFormatter={compact} tick={{ fill: 'hsl(var(--muted-foreground))' }} />
          <Tooltip content={<TrendTooltip currency={currency} />} cursor={{ stroke: 'hsl(var(--border))' }} />
          <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} formatter={(value: string) => <span className="text-muted-foreground">{value}</span>} />
          {SERIES.map((s) => (
            <Line
              key={s.key}
              type="linear"
              dataKey={s.key}
              name={s.name}
              stroke={s.color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={showDots ? { r: 4, fill: s.color, stroke: 'hsl(var(--card))', strokeWidth: 2 } : false}
              activeDot={{ r: 4, fill: s.color, stroke: 'hsl(var(--card))', strokeWidth: 2 }}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
