"use client";

import * as React from "react";
import { AlertTriangle, Ban, CheckCircle2, CircleHelp, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/card";
import { Hint } from "@/components/ui/overlays";
import type { Badge as BadgeData, Confidence, Provenance } from "@/lib/types";
import { cn } from "@/lib/utils";

export function scoreTone(score: number | null | undefined): { ring: string; text: string; label: string } {
  if (score === null || score === undefined) return { ring: "#cbd2dc", text: "text-muted-foreground", label: "Unranked" };
  if (score >= 70) return { ring: "hsl(152 62% 32%)", text: "text-positive", label: "Strong" };
  if (score >= 50) return { ring: "#2a78d6", text: "text-[#1d5fb0]", label: "Solid" };
  if (score >= 30) return { ring: "hsl(32 88% 42%)", text: "text-caution", label: "Marginal" };
  return { ring: "hsl(0 66% 48%)", text: "text-negative", label: "Weak" };
}

/** Circular 0–100 investment score. The number is always shown, never colour alone. */
export function ScoreRing({ score, size = 52, className }: { score: number | null | undefined; size?: number; className?: string }) {
  const tone = scoreTone(score);
  const radius = (size - 6) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = score === null || score === undefined ? 0 : Math.max(0, Math.min(100, score)) / 100;
  return (
    <Hint
      content={
        score === null || score === undefined
          ? "Not ranked: there is not enough income data to calculate returns for this property."
          : `Investment score ${score.toFixed(0)} / 100 (${tone.label.toLowerCase()}). Weighted blend of cash-on-cash, cap rate, cash flow, DSCR, estimate confidence, market risk and data quality.`
      }
    >
      <div className={cn("relative shrink-0", className)} style={{ width: size, height: size }} role="img" aria-label={score == null ? "Investment score unavailable" : `Investment score ${score.toFixed(0)} out of 100`}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={radius} fill="white" stroke="#e6e9ee" strokeWidth="5" />
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={tone.ring} strokeWidth="5" strokeLinecap="round" strokeDasharray={`${circumference * fraction} ${circumference}`} />
        </svg>
        <span className={cn("tnum absolute inset-0 flex items-center justify-center font-semibold", tone.text)} style={{ fontSize: size * 0.3 }}>
          {score === null || score === undefined ? "—" : score.toFixed(0)}
        </span>
      </div>
    </Hint>
  );
}

const CONFIDENCE: Record<Confidence, { label: string; tone: "positive" | "neutral" | "warning" | "negative"; help: string }> = {
  high: { label: "High confidence", tone: "positive", help: "Fresh listing, a property-level estimate with enough comparables, and most cost inputs sourced." },
  medium: { label: "Medium confidence", tone: "neutral", help: "Usable for screening. Some inputs are area-level or estimated — verify before relying on them." },
  low: { label: "Low confidence", tone: "warning", help: "Key inputs are estimates or missing. Scores are capped at 70 until better data is available." },
  insufficient: { label: "Insufficient data", tone: "negative", help: "Not enough data to rank this property reliably. Scores are capped at 40." },
};

export function ConfidenceBadge({ level, short = false }: { level: Confidence; short?: boolean }) {
  const meta = CONFIDENCE[level];
  return (
    <Hint content={meta.help}>
      <Badge tone={meta.tone} tabIndex={0}>
        {short ? meta.label.replace(" confidence", "") : meta.label}
      </Badge>
    </Hint>
  );
}

const PROVENANCE: Record<Provenance, { label: string; dot: string; help: string }> = {
  verified: { label: "Source", dot: "bg-positive", help: "Reported by the listing or a public record source." },
  estimated: { label: "Estimate", dot: "bg-caution", help: "Provider estimate or calculated from a rate — verify before relying on it." },
  default: { label: "Default", dot: "bg-[#94a3b8]", help: "Standard modelling assumption. Change it to match your situation." },
  user: { label: "Yours", dot: "bg-[#2a78d6]", help: "Entered by you." },
  unavailable: { label: "Missing", dot: "bg-negative", help: "No data available. A value is assumed or the scenario cannot be calculated." },
};

export function ProvenanceDot({ source, withLabel = false }: { source: Provenance | undefined; withLabel?: boolean }) {
  if (!source) return null;
  const meta = PROVENANCE[source];
  return (
    <Hint content={`${meta.label}: ${meta.help}`}>
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground" tabIndex={0}>
        <span className={cn("size-1.5 rounded-full", meta.dot)} aria-hidden />
        {withLabel ? meta.label : <span className="sr-only">{meta.label}</span>}
      </span>
    </Hint>
  );
}

export function ProvenanceLegend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
      {(Object.keys(PROVENANCE) as Provenance[]).map((key) => (
        <span key={key} className="inline-flex items-center gap-1.5">
          <span className={cn("size-1.5 rounded-full", PROVENANCE[key].dot)} aria-hidden />
          {PROVENANCE[key].label}
        </span>
      ))}
    </div>
  );
}

const LEGALITY = {
  permitted: { tone: "positive", Icon: CheckCircle2 },
  restricted: { tone: "warning", Icon: ShieldAlert },
  prohibited: { tone: "negative", Icon: Ban },
  unknown: { tone: "outline", Icon: CircleHelp },
} as const;

export function LegalityBadge({ status, label }: { status: string; label: string }) {
  const meta = LEGALITY[(status as keyof typeof LEGALITY) in LEGALITY ? (status as keyof typeof LEGALITY) : "unknown"];
  return (
    <Badge tone={meta.tone}>
      <meta.Icon className="size-3" aria-hidden />
      STR: {label}
    </Badge>
  );
}

export function RuleBadges({ badges, max }: { badges: BadgeData[]; max?: number }) {
  const shown = max ? badges.slice(0, max) : badges;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((badge) => (
        <Hint key={badge.key} content={badge.detail}>
          <Badge tone={badge.tone} tabIndex={0}>
            {badge.key === "needs_verification" ? <AlertTriangle className="size-3" aria-hidden /> : null}
            {badge.label}
          </Badge>
        </Hint>
      ))}
      {max && badges.length > max ? <Badge tone="outline">+{badges.length - max}</Badge> : null}
    </div>
  );
}

export function DemoTag({ className }: { className?: string }) {
  return (
    <Hint content="Synthetic sample data generated for the demo — not a real property or listing.">
      <Badge tone="demo" className={cn("font-semibold uppercase tracking-wide", className)} tabIndex={0}>
        Demo
      </Badge>
    </Hint>
  );
}

export function Metric({ label, value, tone, hint, sub }: { label: string; value: React.ReactNode; tone?: string; hint?: string; sub?: React.ReactNode }) {
  const body = (
    <div className="min-w-0">
      <dt className="truncate text-[11px] text-muted-foreground">{label}</dt>
      <dd className={cn("tnum truncate text-sm font-semibold", tone)}>{value}</dd>
      {sub ? <dd className="truncate text-[11px] text-muted-foreground">{sub}</dd> : null}
    </div>
  );
  return hint ? <Hint content={hint}>{body}</Hint> : body;
}
