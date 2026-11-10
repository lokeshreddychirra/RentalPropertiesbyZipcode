"use client";

import * as React from "react";
import { ChevronDown, RotateCcw, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label, NumberInput, Switch } from "@/components/ui/form";
import { Hint } from "@/components/ui/overlays";
import type { AssumptionOverrides, Assumptions, AssumptionSection, PropertyAnalysis, Provenance } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ProvenanceDot, ProvenanceLegend } from "./bits";

type Unit = "usd" | "pct" | "years" | "nights" | "months" | "bool";

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
}

interface GroupDef {
  key: string;
  title: string;
  fields: FieldDef[];
}

const expense = (key: string) => (analysis: PropertyAnalysis) =>
  (analysis.long_term.available ? analysis.long_term.expenses : analysis.short_term.expenses)?.find((line) => line.key === key)?.annual;

export const GROUPS: GroupDef[] = [
  {
    key: "purchase",
    title: "Purchase & financing",
    fields: [
      { section: "acquisition", name: "purchase_price", label: "Purchase price", unit: "usd", help: "Defaults to the asking price. Change it to model an offer." },
      { section: "financing", name: "down_payment_pct", label: "Down payment", unit: "pct", help: "100% models an all-cash purchase. Below 20% adds PMI." },
      { section: "financing", name: "interest_rate_pct", label: "Interest rate", unit: "pct" },
      { section: "financing", name: "loan_term_years", label: "Loan term", unit: "years" },
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
    title: "Long-term rental",
    fields: [
      { section: "long_term", name: "monthly_rent", label: "Monthly rent", unit: "usd", help: "Override the estimate with a rent you have verified.", nullable: true },
      { section: "long_term", name: "vacancy_pct", label: "Vacancy", unit: "pct" },
      { section: "long_term", name: "management_pct", label: "Property management", unit: "pct", help: "Percent of collected rent. Use 0 if self-managing." },
      { section: "long_term", name: "maintenance_pct", label: "Maintenance", unit: "pct", help: "Percent of gross rent", advanced: true },
      { section: "long_term", name: "capex_pct", label: "CapEx reserve", unit: "pct", help: "Percent of gross rent set aside for roof, HVAC, etc.", advanced: true },
      { section: "long_term", name: "leasing_fee_pct_of_monthly_rent", label: "Leasing fee", unit: "pct", help: "Percent of one month's rent per new tenant", advanced: true },
      { section: "long_term", name: "annual_turnover_pct", label: "Tenant turnover", unit: "pct", help: "Share of years with a new tenant", advanced: true },
      { section: "long_term", name: "owner_utilities_monthly", label: "Owner-paid utilities / mo", unit: "usd", advanced: true },
      { section: "long_term", name: "other_income_monthly", label: "Other income / mo", unit: "usd", advanced: true },
    ],
  },
  {
    key: "str",
    title: "Short-term rental",
    fields: [
      { section: "short_term", name: "adr", label: "Average daily rate", unit: "usd", nullable: true },
      { section: "short_term", name: "occupancy_pct", label: "Occupancy", unit: "pct", help: "Share of available nights that are booked", nullable: true },
      { section: "short_term", name: "management_pct", label: "STR management", unit: "pct", help: "Percent of accommodation revenue. Use 0 if self-managing." },
      { section: "short_term", name: "furnishing_cost", label: "Furnishing (upfront)", unit: "usd" },
      { section: "short_term", name: "unavailable_nights", label: "Unavailable nights / yr", unit: "nights", help: "Owner use, maintenance and blocked nights", advanced: true },
      { section: "short_term", name: "max_rentable_nights", label: "Legal night cap / yr", unit: "nights", help: "Maximum rentable nights allowed by local rules or the HOA, if any", advanced: true, nullable: true },
      { section: "short_term", name: "avg_stay_nights", label: "Average stay", unit: "nights", advanced: true },
      { section: "short_term", name: "cleaning_fee_per_stay", label: "Cleaning fee charged / stay", unit: "usd", advanced: true },
      { section: "short_term", name: "adr_includes_cleaning_fee", label: "Rate already includes cleaning fees", unit: "bool", help: "Turn on when the nightly-rate source bundles cleaning fees, so they are not counted twice.", advanced: true },
      { section: "short_term", name: "cleaning_cost_per_turnover", label: "Cleaning cost / turnover", unit: "usd", advanced: true },
      { section: "short_term", name: "platform_fee_pct", label: "Host / platform fee", unit: "pct", advanced: true },
      { section: "short_term", name: "booking_fee_pct", label: "Booking / payment fee", unit: "pct", advanced: true },
      { section: "short_term", name: "maintenance_pct", label: "Maintenance", unit: "pct", help: "Percent of accommodation revenue", advanced: true },
      { section: "short_term", name: "capex_pct", label: "CapEx reserve", unit: "pct", advanced: true },
      { section: "short_term", name: "utilities_monthly", label: "Utilities / mo", unit: "usd", advanced: true },
      { section: "short_term", name: "internet_monthly", label: "Internet / mo", unit: "usd", advanced: true },
      { section: "short_term", name: "consumables_per_turnover", label: "Supplies / turnover", unit: "usd", advanced: true },
      { section: "short_term", name: "permit_fees_annual", label: "Permits & licences / yr", unit: "usd", advanced: true },
      { section: "short_term", name: "additional_insurance_annual", label: "Extra STR insurance / yr", unit: "usd", advanced: true },
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
    fields: [
      { section: "forecast", name: "rent_growth_pct", label: "Annual rent growth", unit: "pct" },
      { section: "forecast", name: "appreciation_pct", label: "Annual appreciation", unit: "pct" },
      { section: "forecast", name: "expense_inflation_pct", label: "Expense inflation", unit: "pct" },
      { section: "forecast", name: "selling_cost_pct", label: "Selling costs", unit: "pct", advanced: true },
      { section: "forecast", name: "vacancy_change_pct_per_year", label: "Vacancy drift / yr", unit: "pct", help: "Percentage points added to vacancy (or removed from STR occupancy) each year", advanced: true },
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

interface Props {
  analysis: PropertyAnalysis;
  overrides: AssumptionOverrides;
  onChange: (section: AssumptionSection, field: string, value: number | boolean | null | undefined) => void;
  onResetAll: () => void;
  pending?: boolean;
  className?: string;
}

function valueOf(assumptions: Assumptions, field: FieldDef): number | boolean | null {
  const section = assumptions[field.section as keyof Assumptions] as Record<string, unknown>;
  const raw = section?.[field.name];
  return raw === undefined ? null : (raw as number | boolean | null);
}

export function AssumptionsPanel({ analysis, overrides, onChange, onResetAll, pending, className }: Props) {
  const [open, setOpen] = React.useState<Record<string, boolean>>({ purchase: true, ltr: true, str: true, fixed: false, forecast: false });
  const [advanced, setAdvanced] = React.useState<Record<string, boolean>>({});
  const overrideCount = Object.values(overrides ?? {}).reduce((sum, fields) => sum + Object.keys((fields ?? {}) as object).length, 0);

  return (
    <div className={cn("space-y-3", className)} data-testid="assumptions-panel">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Assumptions</h2>
          <p className="text-[11px] text-muted-foreground">{pending ? "Recalculating…" : "Edit any value — every metric updates immediately."}</p>
        </div>
        {overrideCount > 0 ? (
          <Button variant="ghost" size="sm" onClick={onResetAll}>
            <RotateCcw /> Reset ({overrideCount})
          </Button>
        ) : null}
      </div>
      <ProvenanceLegend />

      {GROUPS.map((group) => {
        const isOpen = open[group.key];
        const showAdvanced = advanced[group.key];
        const basic = group.fields.filter((f) => !f.advanced);
        const extra = group.fields.filter((f) => f.advanced);
        const fields = showAdvanced ? [...basic, ...extra] : basic;
        return (
          <section key={group.key} className="rounded-lg border bg-card">
            <button type="button" className="flex w-full items-center justify-between px-3 py-2.5 text-left text-sm font-medium" aria-expanded={isOpen} onClick={() => setOpen((s) => ({ ...s, [group.key]: !isOpen }))}>
              {group.title}
              <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", isOpen && "rotate-180")} aria-hidden />
            </button>
            {isOpen ? (
              <div className="space-y-2.5 border-t px-3 py-3">
                {fields.map((field) => {
                  const path = `${field.section}.${field.name}`;
                  const provenance = analysis.provenance[path] as Provenance | undefined;
                  const value = valueOf(analysis.assumptions, field);
                  const id = `as-${field.section}-${field.name}`;
                  const overridden = (overrides?.[field.section] as Record<string, unknown> | undefined)?.[field.name] !== undefined;
                  const reset = overridden ? (
                    <Hint content="Restore the original value">
                      <button type="button" className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={`Reset ${field.label}`} onClick={() => onChange(field.section, field.name, undefined)}>
                        <Undo2 className="size-3" />
                      </button>
                    </Hint>
                  ) : null;

                  if (field.unit === "bool") {
                    return (
                      <div key={path} className="flex items-center justify-between gap-3">
                        <Label htmlFor={id} className="flex items-center gap-1.5 leading-snug">
                          {field.label} <ProvenanceDot source={provenance} /> {reset}
                        </Label>
                        <Switch id={id} checked={Boolean(value)} onCheckedChange={(checked) => onChange(field.section, field.name, checked)} />
                      </div>
                    );
                  }
                  const derived = value === null && field.derived ? field.derived(analysis) : null;
                  return (
                    <div key={path} className="grid grid-cols-[minmax(0,1fr)_7.5rem] items-center gap-2">
                      <Label htmlFor={id} className="flex min-w-0 items-center gap-1.5 leading-snug">
                        {field.help ? (
                          <Hint content={field.help}>
                            <span className="truncate underline decoration-dotted underline-offset-2">{field.label}</span>
                          </Hint>
                        ) : (
                          <span className="truncate">{field.label}</span>
                        )}
                        <ProvenanceDot source={provenance} />
                        {reset}
                      </Label>
                      <NumberInput
                        id={id}
                        value={typeof value === "number" ? value : null}
                        placeholder={derived != null ? Math.round(derived).toLocaleString() : field.nullable ? "—" : undefined}
                        onValueChange={(next) => {
                          if (next === null && !field.nullable) return; // keep the last valid value while the box is empty
                          onChange(field.section, field.name, next);
                        }}
                        className="h-8 text-right"
                        {...UNIT_AFFIX[field.unit]}
                      />
                    </div>
                  );
                })}
                {extra.length ? (
                  <button type="button" className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setAdvanced((s) => ({ ...s, [group.key]: !showAdvanced }))}>
                    {showAdvanced ? "Hide detailed parameters" : `Show ${extra.length} detailed parameters`}
                  </button>
                ) : null}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
