'use client';

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export interface ActivityPoint {
  date: string;
  disbursed: number;
  collected: number;
}

function compact(value: number) {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return String(value);
}

export function ActivityChart({ data, currency }: { data: ActivityPoint[]; currency: string }) {
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
          <XAxis dataKey="date" tickLine={false} axisLine={false} fontSize={11} tickFormatter={(d: string) => d.slice(5)} />
          <YAxis tickLine={false} axisLine={false} fontSize={11} tickFormatter={compact} width={48} />
          <Tooltip
            formatter={(value: number) => `${currency} ${value.toLocaleString('en-US', { minimumFractionDigits: 2 })}`}
            contentStyle={{ borderRadius: 8, borderColor: 'hsl(var(--border))', fontSize: 12 }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="disbursed" name="Disbursed" fill="hsl(var(--chart-1))" radius={[4, 4, 0, 0]} />
          <Bar dataKey="collected" name="Collected" fill="hsl(var(--chart-2))" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
