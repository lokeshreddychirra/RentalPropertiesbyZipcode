"use client";

import * as React from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Hint } from "@/components/ui/overlays";
import type { QuickLtr } from "@/lib/ltr-model";
import type { StrategyResult } from "@/lib/types";
import { cn, pct, ratio, usd } from "@/lib/utils";

export type SimKey = "monthly_cash_flow" | "cash_on_cash_pct" | "cap_rate_pct" | "gross_yield_pct" | "dscr" | "total_cash_invested";

interface SimMetric {
  key: SimKey;
  label: string;
  compact: string;
  kind: "usd" | "pts" | "ratio";
  /** Which direction is good for the investor; "none" is shown neutrally. */
  better: "higher" | "none";
  signed?: boolean;
  help: string;
}

export const SIM_METRICS: SimMetric[] = [
  { key: "monthly_cash_flow", label: "Monthly cash flow", compact: "Cash flow / mo", kind: "usd", better: "higher", signed: true, help: "Rent collected minus every operating cost and the mortgage payment." },
  { key: "cash_on_cash_pct", label: "Cash-on-cash", compact: "Cash-on-cash", kind: "pts", better: "higher", signed: true, help: "Yearly cash flow divided by the cash you put in. Moved by price, rent and financing." },
  { key: "cap_rate_pct", label: "Cap rate", compact: "Cap rate", kind: "pts", better: "higher", help: "Net operating income divided by price. Ignores financing, so down payment and rate don't move it." },
  { key: "gross_yield_pct", label: "Gross yield", compact: "Gross yield", kind: "pts", better: "higher", help: "Yearly rent divided by price, before any costs. Only price and rent move it." },
  { key: "dscr", label: "DSCR", compact: "DSCR", kind: "ratio", better: "higher", help: "Net operating income divided by the mortgage payments. Lenders usually want 1.2× or more." },
  { key: "total_cash_invested", label: "Upfront cash", compact: "Cash needed", kind: "usd", better: "none", help: "Down payment, closing costs, repairs and starting reserves." },
];

export function formatSim(metric: SimMetric, value: number | null | undefined): string {
  if (value === null || value === undefined) return metric.kind === "ratio" ? "N/A" : "—";
  if (metric.kind === "usd") return usd(value);
  if (metric.kind === "pts") return pct(value, 2);
  return ratio(value);
}

export type SimValues = Partial<Record<SimKey, number | null | undefined>>;

export function simValues(source: StrategyResult | QuickLtr | null | undefined): SimValues {
  if (!source) return {};
  const s = source as Record<string, unknown>;
  return Object.fromEntries(SIM_METRICS.map((m) => [m.key, (s[m.key] as number | null | undefined) ?? null])) as SimValues;
}

const THRESHOLD: Record<SimMetric["kind"], number> = { usd: 0.5, pts: 0.005, ratio: 0.0005 };

/** Change versus the original assumptions, with an arrow and colour (never colour alone). */
export function Delta({ metric, value, original, className }: { metric: SimMetric; value: number | null | undefined; original: number | null | undefined; className?: string }) {
  if (value == null || original == null) return null;
  const diff = value - original;
  if (Math.abs(diff) < THRESHOLD[metric.kind]) return null;
  const up = diff > 0;
  const abs = Math.abs(diff);
  const text = metric.kind === "usd" ? usd(abs) : metric.kind === "pts" ? `${abs.toFixed(2)} pts` : `${abs.toFixed(2)}×`;
  const tone = metric.better === "none" ? "text-muted-foreground" : up ? "text-positive" : "text-negative";
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <Hint content={`Was ${formatSim(metric, original)} with the original assumptions`}>
      <span className={cn("tnum inline-flex items-center gap-0.5 whitespace-nowrap text-[11px] font-medium", tone, className)} tabIndex={0}>
        <Icon className="size-3" aria-hidden />
        <span className="sr-only">{up ? "up" : "down"} </span>
        {text}
      </span>
    </Hint>
  );
}
