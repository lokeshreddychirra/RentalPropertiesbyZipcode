"use client";

import * as React from "react";
import { ChevronDown, RotateCcw, Undo2 } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Label, NumberInput, Slider, Switch } from "@/components/ui/form";
import { Hint } from "@/components/ui/overlays";
import type { QuickLtr } from "@/lib/ltr-model";
import type { AssumptionOverrides, Assumptions, AssumptionSection, PropertyAnalysis, Provenance } from "@/lib/types";
import { cn, signTone, usd } from "@/lib/utils";
import { ProvenanceDot, ProvenanceLegend } from "./bits";
import { Delta, formatSim, SIM_METRICS, simValues } from "./sim-metrics";

type Unit = "usd" | "pct" | "years" | "nights" | "months" | "bool";

/** What a field's slider, notes and presets can draw on. */
interface Ctx {
  analysis: PropertyAnalysis;
  /** Assumptions before any of the user's changes on this page (asking price, rent estimate…). */
  original: Assumptions;
  live: QuickLtr | null;
}

interface SliderSpec {
  min: number;
  max: number;
  step: number;
}

interface FieldDef {
  section: AssumptionSection;
  name: string;
  label: string;
  unit: Unit;
  help?: string;
  advanced?: boolean;
  /** Shown as placeholder when the stored value is null (e.g. a rate-based estimate). */
  derived?: (analysis: PropertyAnalysis) => number | null | undefined;
  nullable?: boolean;
  slider?: (ctx: Ctx) => SliderSpec | null;
  /** Segmented choices instead of a slider (e.g. loan term). */
  choices?: number[];
  presets?: { label: string; value: number }[];
  note?: (value: number, ctx: Ctx) => React.ReactNode;
}

interface GroupDef {
  key: string;
  title: string;
  subtitle?: string;
  fields: FieldDef[];
}

const expense = (key: string) => (analysis: PropertyAnalysis) => analysis.long_term.expenses?.find((line) => line.key === key)?.annual;

const roundTo = (value: number, step: number) => Math.round(value / step) * step;
const priceStep = (price: number) => (price < 150_000 ? 500 : price < 1_000_000 ? 1_000 : 5_000);
const rentStep = (rent: number) => (rent < 1_000 ? 10 : 25);
const fixedRange = (min: number, max: number, step: number) => () => ({ min, max, step });

export const GROUPS: GroupDef[] = [
  {
    key: "purchase",
    title: "Purchase & financing",
    fields: [
      {
        section: "acquisition",
        name: "purchase_price",
        label: "Purchase price",
        unit: "usd",
        help: "Defaults to the asking price. Slide it to model an offer.",
        slider: ({ original }) => {
          const asking = Number(original.acquisition.purchase_price) || 0;
          if (asking <= 0) return null;
          // Anchored on the asking price so sliding back always lands on it exactly.
          const step = priceStep(asking);
          return { min: Math.max(step, asking - roundTo(asking * 0.4, step)), max: asking + roundTo(asking * 0.15, step), step };
        },
        note: (value, { original }) => {
          const asking = Number(original.acquisition.purchase_price) || 0;
          if (!asking) return null;
          const diff = (value - asking) / asking;
          if (Math.abs(diff) < 0.005) return "Asking price";
          return `${Math.abs(diff * 100).toFixed(0)}% ${diff < 0 ? "below" : "above"} asking (${usd(asking)})`;
        },
      },
      {
        section: "financing",
        name: "down_payment_pct",
        label: "Down payment",
        unit: "pct",
        help: "100% models an all-cash purchase. Below 20% adds PMI.",
        slider: fixedRange(0, 100, 0.5),
        presets: [
          { label: "3.5%", value: 3.5 },
          { label: "10%", value: 10 },
          { label: "20%", value: 20 },
          { label: "25%", value: 25 },
          { label: "Cash", value: 100 },
        ],
        note: (value, { live }) => {
          if (!live) return null;
          if (value >= 100) return `All cash: ${usd(live.down_payment)}, no mortgage`;
          return `${usd(live.down_payment)} down · ${usd(live.loan_amount)} loan${value < 20 && value > 0 ? " · PMI applies" : ""}`;
        },
      },
      {
        section: "financing",
        name: "interest_rate_pct",
        label: "Interest rate",
        unit: "pct",
        slider: fixedRange(2, 12, 0.125),
        note: (_value, { live }) => (live && live.loan_amount > 0 ? `${usd(live.monthly_payment)} / mo mortgage payment` : null),
      },
      { section: "financing", name: "loan_term_years", label: "Loan term", unit: "years", choices: [15, 20, 30] },
      { section: "acquisition", name: "closing_cost_pct", label: "Closing costs", unit: "pct", help: "Percent of purchase price", advanced: true },
      { section: "acquisition", name: "inspection_cost", label: "Inspection", unit: "usd", advanced: true },
      { section: "acquisition", name: "renovation_cost", label: "Renovation", unit: "usd", advanced: true },
      { section: "acquisition", name: "initial_repair_budget", label: "Initial repairs", unit: "usd", advanced: true },
      { section: "acquisition", name: "other_acquisition_costs", label: "Other acquisition costs", unit: "usd", advanced: true },
      { section: "acquisition", name: "reserve_months", label: "Cash reserves", unit: "months", help: "Months of fixed carrying costs (debt, taxes, insurance, HOA) held in reserve", advanced: true },
      { section: "financing", name: "pmi_annual_rate_pct", label: "PMI rate", unit: "pct", help: "Annual, on the loan amount; charged while LTV is above 78%", advanced: true },
    ],
  },
  {
    key: "ltr",
    title: "Rent & operations",
    fields: [
      {
        section: "long_term",
        name: "monthly_rent",
        label: "Monthly rent",
        unit: "usd",
        help: "Override the estimate with a rent you have verified.",
        nullable: true,
        // Without an estimate there is nothing to anchor a range on: the box alone is shown.
        slider: ({ original }) => {
          const estimate = Number(original.long_term.monthly_rent) || 0;
          if (estimate <= 0) return null;
          // Anchored on the estimate so sliding back always lands on it exactly.
          const step = rentStep(estimate);
          const span = roundTo(estimate * 0.5, step);
          return { min: estimate - span, max: estimate + span, step };
        },
        note: (value, { original }) => {
          const estimate = Number(original.long_term.monthly_rent) || 0;
          if (!estimate) return null;
          const diff = (value - estimate) / estimate;
          if (Math.abs(diff) < 0.005) return "Rent estimate";
          return `${Math.abs(diff * 100).toFixed(0)}% ${diff < 0 ? "below" : "above"} the ${usd(estimate)} estimate`;
        },
      },
      {
        section: "long_term",
        name: "vacancy_pct",
        label: "Vacancy",
        unit: "pct",
        help: "Share of the year the home sits empty between tenants.",
        slider: fixedRange(0, 25, 0.5),
        note: (value) => `About ${Math.round((365 * value) / 100)} days empty a year`,
      },
      {
        section: "long_term",
        name: "management_pct",
        label: "Property management",
        unit: "pct",
        help: "Percent of collected rent. Use 0 if self-managing.",
        slider: fixedRange(0, 15, 0.5),
        note: (value) => (value === 0 ? "Self-managed" : null),
      },
      { section: "long_term", name: "maintenance_pct", label: "Maintenance", unit: "pct", help: "Percent of gross rent", advanced: true },
      { section: "long_term", name: "capex_pct", label: "CapEx reserve", unit: "pct", help: "Percent of gross rent set aside for roof, HVAC, etc.", advanced: true },
      { section: "long_term", name: "leasing_fee_pct_of_monthly_rent", label: "Leasing fee", unit: "pct", help: "Percent of one month's rent per new tenant", advanced: true },
      { section: "long_term", name: "annual_turnover_pct", label: "Tenant turnover", unit: "pct", help: "Share of years with a new tenant", advanced: true },
      { section: "long_term", name: "owner_utilities_monthly", label: "Owner-paid utilities / mo", unit: "usd", advanced: true },
      { section: "long_term", name: "other_income_monthly", label: "Other income / mo", unit: "usd", advanced: true },
    ],
  },
  {
    key: "fixed",
    title: "Ownership costs",
    fields: [
      { section: "fixed", name: "property_tax_annual", label: "Property tax / yr", unit: "usd", derived: expense("property_tax"), nullable: true, help: "Leave blank to estimate from the tax rate × price." },
      { section: "fixed", name: "insurance_annual", label: "Insurance / yr", unit: "usd", derived: expense("insurance"), nullable: true, help: "Leave blank to estimate from the insurance rate × price." },
      { section: "fixed", name: "hoa_monthly", label: "HOA / mo", unit: "usd" },
      { section: "fixed", name: "other_monthly", label: "Other recurring / mo", unit: "usd", advanced: true },
      { section: "fixed", name: "property_tax_rate_pct", label: "Tax rate (if estimating)", unit: "pct", advanced: true },
      { section: "fixed", name: "insurance_rate_pct", label: "Insurance rate (if estimating)", unit: "pct", advanced: true },
    ],
  },
  {
    key: "forecast",
    title: "Growth & exit",
    subtitle: "Changes the Forecast tab, not year-one returns.",
    fields: [
      { section: "forecast", name: "rent_growth_pct", label: "Annual rent growth", unit: "pct", slider: fixedRange(0, 8, 0.25) },
      { section: "forecast", name: "appreciation_pct", label: "Annual appreciation", unit: "pct", slider: fixedRange(0, 10, 0.25) },
      { section: "forecast", name: "expense_inflation_pct", label: "Expense inflation", unit: "pct", slider: fixedRange(0, 8, 0.25) },
      { section: "forecast", name: "selling_cost_pct", label: "Selling costs", unit: "pct", advanced: true },
      { section: "forecast", name: "vacancy_change_pct_per_year", label: "Vacancy drift / yr", unit: "pct", help: "Percentage points added to vacancy each year", advanced: true },
    ],
  },
];

const UNIT_AFFIX: Record<Unit, { prefix?: string; suffix?: string }> = {
  usd: { prefix: "$" },
  pct: { suffix: "%" },
  years: { suffix: "yr" },
  nights: { suffix: "nts" },
  months: { suffix: "mo" },
  bool: {},
};

function spoken(unit: Unit, value: number): string {
  if (unit === "usd") return usd(value);
  if (unit === "pct") return `${value} percent`;
  if (unit === "years") return `${value} years`;
  return String(value);
}

interface Props {
  analysis: PropertyAnalysis;
  /** The analysis with no changes from this page; used for slider ranges and "vs original". */
  baseline?: PropertyAnalysis;
  /** Instant year-one result for the current inputs, shown while the server recalculates. */
  live?: QuickLtr | null;
  overrides: AssumptionOverrides;
  onChange: (section: AssumptionSection, field: string, value: unknown) => void;
  onResetAll: () => void;
  pending?: boolean;
  className?: string;
}

function valueOf(assumptions: Assumptions, field: FieldDef): number | boolean | null {
  const section = assumptions[field.section as keyof Assumptions] as Record<string, unknown>;
  const raw = section?.[field.name];
  return raw === undefined ? null : (raw as number | boolean | null);
}

/** The value to show for a field: the user's latest edit if any, else the analysed value. */
function currentValue(analysis: PropertyAnalysis, overrides: AssumptionOverrides, field: FieldDef): number | boolean | null {
  const edited = (overrides?.[field.section] as Record<string, unknown> | undefined)?.[field.name];
  if (edited !== undefined) return edited as number | boolean | null;
  return valueOf(analysis.assumptions, field);
}

function Results({ analysis, baseline, live, pending }: { analysis: PropertyAnalysis; baseline?: PropertyAnalysis; live?: QuickLtr | null; pending?: boolean }) {
  const current = simValues(pending && live ? live : analysis.long_term);
  const original = simValues(baseline?.long_term);
  const available = (pending && live) || analysis.long_term.available;
  return (
    <div className="sticky top-0 z-10 -mx-1 bg-background px-1 pb-2 pt-1 [[role=dialog]_&]:-top-5 [[role=dialog]_&]:bg-card [[role=dialog]_&]:pt-5" data-testid="sim-results">
      <div className="glass-strong rounded-xl p-3">
        {available ? (
          <dl className="grid grid-cols-3 gap-x-2 gap-y-2.5">
            {SIM_METRICS.map((metric) => {
              const value = current[metric.key];
              return (
                <div key={metric.key} className="min-w-0">
                  <Hint content={metric.help}>
                    <dt className="truncate text-[10.5px] leading-tight text-muted-foreground" tabIndex={0}>
                      {metric.compact}
                    </dt>
                  </Hint>
                  <dd className={cn("tnum truncate text-sm font-semibold", metric.signed && signTone(value))}>{formatSim(metric, value)}</dd>
                  <dd className="h-4 leading-4">
                    <Delta metric={metric} value={value} original={original[metric.key]} />
                  </dd>
                </div>
              );
            })}
          </dl>
        ) : (
          <p className="text-xs text-muted-foreground">Enter a monthly rent below to see returns.</p>
        )}
      </div>
    </div>
  );
}

export function AssumptionsPanel({ analysis, baseline, live = null, overrides, onChange, onResetAll, pending, className }: Props) {
  const [open, setOpen] = React.useState<Record<string, boolean>>({ purchase: true, ltr: true, fixed: false, forecast: false });
  const [advanced, setAdvanced] = React.useState<Record<string, boolean>>({});
  const overrideCount = Object.values(overrides ?? {}).reduce((sum, fields) => sum + Object.keys((fields ?? {}) as object).length, 0);
  const ctx: Ctx = { analysis, original: (baseline ?? analysis).assumptions, live };

  return (
    <div className={cn("space-y-3", className)} data-testid="assumptions-panel">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Deal simulator</h2>
          <p className="text-[11px] text-muted-foreground">Drag a slider or type a value. Returns update as you go.</p>
        </div>
        {overrideCount > 0 ? (
          <Button variant="ghost" size="sm" onClick={onResetAll}>
            <RotateCcw /> Reset all
          </Button>
        ) : null}
      </div>

      <Results analysis={analysis} baseline={baseline} live={live} pending={pending} />

      {GROUPS.map((group) => {
        const isOpen = open[group.key];
        const showAdvanced = advanced[group.key];
        const basic = group.fields.filter((f) => !f.advanced);
        const extra = group.fields.filter((f) => f.advanced);
        const fields = showAdvanced ? [...basic, ...extra] : basic;
        return (
          <section key={group.key} className="glass rounded-xl">
            <button type="button" className="flex w-full items-center justify-between px-3 py-2.5 text-left text-sm font-medium" aria-expanded={isOpen} onClick={() => setOpen((s) => ({ ...s, [group.key]: !isOpen }))}>
              {group.title}
              <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", isOpen && "rotate-180")} aria-hidden />
            </button>
            {isOpen ? (
              <div className="space-y-3 border-t px-3 py-3">
                {group.subtitle ? <p className="-mt-1 text-[11px] text-muted-foreground">{group.subtitle}</p> : null}
                {fields.map((field) => (
                  <FieldRow key={`${field.section}.${field.name}`} field={field} ctx={ctx} overrides={overrides} onChange={onChange} />
                ))}
                {extra.length ? (
                  <button type="button" className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setAdvanced((s) => ({ ...s, [group.key]: !showAdvanced }))}>
                    {showAdvanced ? "Hide detailed settings" : `Show ${extra.length} detailed settings`}
                  </button>
                ) : null}
              </div>
            ) : null}
          </section>
        );
      })}

      <div className="space-y-1 pt-1">
        <p className="text-[11px] font-medium text-muted-foreground">Where each value comes from</p>
        <ProvenanceLegend />
      </div>
    </div>
  );
}

function FieldRow({ field, ctx, overrides, onChange }: { field: FieldDef; ctx: Ctx; overrides: AssumptionOverrides; onChange: Props["onChange"] }) {
  const { analysis } = ctx;
  const path = `${field.section}.${field.name}`;
  const id = `as-${field.section}-${field.name}`;
  const provenance = analysis.provenance[path] as Provenance | undefined;
  const value = currentValue(analysis, overrides, field);
  const overridden = (overrides?.[field.section] as Record<string, unknown> | undefined)?.[field.name] !== undefined;
  const set = (next: unknown) => onChange(field.section, field.name, next);

  const label = (
    <Label htmlFor={id} className="flex min-w-0 items-center gap-1.5 leading-snug">
      {field.help ? (
        <Hint content={field.help}>
          <span className="truncate underline decoration-dotted underline-offset-2">{field.label}</span>
        </Hint>
      ) : (
        <span className="truncate">{field.label}</span>
      )}
      <ProvenanceDot source={provenance} />
      {overridden ? (
        <Hint content="Restore the original value">
          <button type="button" className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={`Reset ${field.label}`} onClick={() => set(undefined)}>
            <Undo2 className="size-3" />
          </button>
        </Hint>
      ) : null}
    </Label>
  );

  if (field.unit === "bool") {
    return (
      <div className="flex items-center justify-between gap-3">
        {label}
        <Switch id={id} checked={Boolean(value)} onCheckedChange={(checked) => set(checked)} />
      </div>
    );
  }

  const numeric = typeof value === "number" ? value : null;

  if (field.choices) {
    const choices = numeric != null && !field.choices.includes(numeric) ? [...field.choices, numeric].sort((a, b) => a - b) : field.choices;
    return (
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{label}</span>
        <div role="radiogroup" aria-label={field.label} className="inline-flex rounded-md border bg-muted p-0.5">
          {choices.map((choice) => (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={numeric === choice}
              onClick={() => set(choice)}
              className={cn("tnum rounded px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground", numeric === choice && "bg-card text-foreground shadow-sm")}
            >
              {choice} {UNIT_AFFIX[field.unit].suffix}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const spec = numeric != null && field.slider ? field.slider(ctx) : null;
  const derived = value === null && field.derived ? field.derived(analysis) : null;
  const note = numeric != null && field.note ? field.note(numeric, ctx) : null;
  const input = (
    <NumberInput
      id={id}
      value={numeric}
      placeholder={derived != null ? Math.round(derived).toLocaleString() : field.nullable ? "—" : undefined}
      onValueChange={(next) => {
        if (next === null && !field.nullable) return; // keep the last valid value while the box is empty
        set(next);
      }}
      className="h-8 text-right"
      {...UNIT_AFFIX[field.unit]}
    />
  );

  if (!spec || numeric == null) {
    return (
      <div className="grid grid-cols-[minmax(0,1fr)_7.5rem] items-center gap-2">
        {label}
        {input}
      </div>
    );
  }

  // Keep the current value inside the slider's range, even if it was typed outside it.
  const min = Math.min(spec.min, numeric);
  const max = Math.max(spec.max, numeric);
  return (
    <div className="space-y-1" data-testid={`sim-${field.name}`}>
      <div className="grid grid-cols-[minmax(0,1fr)_7.5rem] items-center gap-2">
        {label}
        {input}
      </div>
      <Slider id={`${id}-slider`} label={field.label} value={numeric} min={min} max={max} step={spec.step} valueText={spoken(field.unit, numeric)} onValueChange={(next) => set(next)} />
      {note ? <p className="tnum text-[11px] leading-tight text-muted-foreground">{note}</p> : null}
      {field.presets ? (
        <div className="flex flex-wrap gap-1 pt-0.5" role="group" aria-label={`${field.label} presets`}>
          {field.presets.map((preset) => (
            <button
              key={preset.label}
              type="button"
              aria-pressed={numeric === preset.value}
              onClick={() => set(preset.value)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground",
                numeric === preset.value && "border-primary bg-primary/10 text-primary",
              )}
            >
              {preset.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
