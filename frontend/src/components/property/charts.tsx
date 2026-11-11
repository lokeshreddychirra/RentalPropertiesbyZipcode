"use client";

import * as React from "react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ForecastResult, PropertyAnalysis, StrategyResult } from "@/lib/types";
import { pct, usd, usdCompact } from "@/lib/utils";

// Categorical series colours (fixed order, never cycled). Status colours are not used for series.
// Colours are theme tokens, so charts follow the light and dark themes.
export const SERIES = {
  ltr: "var(--series-ltr)",
  str: "var(--series-str)",
  third: "var(--series-3)",
  fourth: "var(--series-4)",
};
const AXIS = { fontSize: 12, fill: "var(--chart-axis)" };
const GRID = "var(--chart-grid)";

interface TipProps {
  active?: boolean;
  label?: string | number;
  payload?: { name?: string; value?: number | null; color?: string; dataKey?: string | number }[];
  format: (value: number) => string;
  labelPrefix?: string;
}

function Tip({ active, payload, label, format, labelPrefix }: TipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="glass-strong rounded-xl px-3 py-2 text-xs">
      <p className="mb-1 font-medium">
        {labelPrefix}
        {label}
      </p>
      {payload.map((item) => (
        <p key={String(item.dataKey)} className="tnum flex items-center justify-between gap-4">
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span className="size-2 rounded-full" style={{ backgroundColor: item.color }} aria-hidden />
            {item.name}
          </span>
          <span className="font-medium text-foreground">{item.value == null ? "—" : format(item.value)}</span>
        </p>
      ))}
    </div>
  );
}

function Frame({ height = 260, label, children }: { height?: number; label: string; children: React.ReactElement }) {
  return (
    <div style={{ height }} role="img" aria-label={label} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

/** Long-term rental return metrics (one percent axis). */
export function ReturnComparisonChart({ analysis }: { analysis: PropertyAnalysis }) {
  const { long_term: ltr } = analysis;
  const rows = [
    { metric: "Gross yield", ltr: ltr.gross_yield_pct },
    { metric: "Cap rate", ltr: ltr.cap_rate_pct },
    { metric: "Net yield", ltr: ltr.net_yield_pct },
    { metric: "Cash-on-cash", ltr: ltr.cash_on_cash_pct },
  ];
  return (
    <Frame label="Return metrics for the long-term rental">
      <BarChart data={rows} margin={{ top: 18, right: 8, left: 0, bottom: 0 }} barGap={2} barCategoryGap="24%">
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="metric" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => `${v}%`} />
        <ReferenceLine y={0} stroke="var(--chart-axis)" />
        <Tooltip cursor={{ fill: "var(--chart-cursor)" }} content={<Tip format={(v) => pct(v, 2)} />} />
        {ltr.available ? (
          <Bar dataKey="ltr" name="Return" fill={SERIES.ltr} radius={[4, 4, 0, 0]} maxBarSize={36}>
            <LabelList dataKey="ltr" position="top" formatter={(v: unknown) => (typeof v === "number" ? `${v.toFixed(1)}%` : "")} style={{ fontSize: 10, fill: "var(--chart-label)" }} />
          </Bar>
        ) : null}
      </BarChart>
    </Frame>
  );
}

/** Annual operating expenses, largest first (magnitude → one hue). */
export function ExpenseChart({ result, color }: { result: StrategyResult; color: string }) {
  const rows = [...(result.expenses ?? [])].filter((line) => line.annual > 0).sort((a, b) => b.annual - a.annual);
  return (
    <Frame height={Math.max(160, rows.length * 30 + 20)} label="Annual operating expenses by category">
      <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 64, left: 0, bottom: 0 }}>
        <XAxis type="number" hide />
        <YAxis type="category" dataKey="label" tick={AXIS} tickLine={false} axisLine={false} width={150} />
        <Tooltip cursor={{ fill: "var(--chart-cursor)" }} content={<Tip format={(v) => `${usd(v)} / yr`} />} />
        <Bar dataKey="annual" name="Annual cost" fill={color} radius={[0, 4, 4, 0]} maxBarSize={16}>
          <LabelList dataKey="annual" position="right" formatter={(v: unknown) => (typeof v === "number" ? usd(v) : "")} style={{ fontSize: 11, fill: "var(--chart-label)" }} />
        </Bar>
      </BarChart>
    </Frame>
  );
}

export function ForecastWealthChart({ forecast, years }: { forecast: ForecastResult; years: number }) {
  const rows = forecast.years.filter((y) => y.year <= years);
  return (
    <Frame height={280} label={`Equity, loan balance and cumulative cash flow over ${years} years`}>
      <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="year" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} tickFormatter={(v: number) => `Yr ${v}`} minTickGap={24} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => usdCompact(v)} />
        <ReferenceLine y={0} stroke="var(--chart-axis)" />
        <Tooltip content={<Tip format={(v) => usd(v)} labelPrefix="Year " />} />
        <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
        <Line type="monotone" dataKey="equity" name="Estimated equity" stroke={SERIES.ltr} strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="loan_balance" name="Loan balance" stroke={SERIES.str} strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="cumulative_cash_flow" name="Cumulative cash flow" stroke={SERIES.third} strokeWidth={2} dot={false} />
      </LineChart>
    </Frame>
  );
}

export function ForecastCashFlowChart({ forecast, years, color }: { forecast: ForecastResult; years: number; color: string }) {
  const rows = forecast.years.filter((y) => y.year <= years);
  return (
    <Frame height={220} label={`Annual pre-tax cash flow over ${years} years`}>
      <BarChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} barCategoryGap="18%">
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="year" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} tickFormatter={(v: number) => `Yr ${v}`} minTickGap={24} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => usdCompact(v)} />
        <ReferenceLine y={0} stroke="var(--chart-axis)" />
        <Tooltip cursor={{ fill: "var(--chart-cursor)" }} content={<Tip format={(v) => usd(v)} labelPrefix="Year " />} />
        <Bar dataKey="cash_flow" name="Annual cash flow" fill={color} radius={[3, 3, 0, 0]} maxBarSize={22}>
          {rows.map((row) => (
            <Cell key={row.year} fillOpacity={row.cash_flow < 0 ? 0.45 : 1} />
          ))}
        </Bar>
      </BarChart>
    </Frame>
  );
}

export function TrendChart({ rows, dataKey, name, color, format }: { rows: Record<string, unknown>[]; dataKey: string; name: string; color: string; format: (v: number) => string }) {
  return (
    <Frame height={220} label={`${name} over the last 12 months`}>
      <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="month" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={28} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={60} tickFormatter={(v: number) => format(v)} domain={["auto", "auto"]} />
        <Tooltip content={<Tip format={format} />} />
        <Line type="monotone" dataKey={dataKey} name={name} stroke={color} strokeWidth={2} dot={{ r: 2.5 }} activeDot={{ r: 4 }} />
      </LineChart>
    </Frame>
  );
}

export function SimpleBarChart({ rows, xKey, dataKey, name, color, format, height = 220 }: { rows: Record<string, unknown>[]; xKey: string; dataKey: string; name: string; color: string; format: (v: number) => string; height?: number }) {
  return (
    <Frame height={height} label={name}>
      <BarChart data={rows} margin={{ top: 18, right: 8, left: 0, bottom: 0 }} barCategoryGap="28%">
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey={xKey} tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={52} tickFormatter={(v: number) => format(v)} />
        <Tooltip cursor={{ fill: "var(--chart-cursor)" }} content={<Tip format={format} />} />
        <Bar dataKey={dataKey} name={name} fill={color} radius={[4, 4, 0, 0]} maxBarSize={44}>
          <LabelList dataKey={dataKey} position="top" formatter={(v: unknown) => (typeof v === "number" ? format(v) : "")} style={{ fontSize: 10, fill: "var(--chart-label)" }} />
        </Bar>
      </BarChart>
    </Frame>
  );
}
