"use client";

import * as React from "react";
import { ChevronDown, RotateCcw, Search, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card } from "@/components/ui/card";
import { Field, Input, NumberInput, Select } from "@/components/ui/form";
import { api, errorMessage } from "@/lib/api";
import { EMPTY_FORM, filtersToForm, formToFilters, hasLocation, US_STATES, type FilterForm } from "@/lib/filters";
import { useStatus } from "@/lib/store";
import type { NLParseResult, SearchFilters, SortKey } from "@/lib/types";
import { cn } from "@/lib/utils";

const PROPERTY_TYPES: { value: string; label: string }[] = [
  { value: "single_family", label: "Single family" },
  { value: "condo", label: "Condo" },
  { value: "townhouse", label: "Townhouse" },
  { value: "multi_family", label: "Multi-family" },
  { value: "manufactured", label: "Manufactured" },
  { value: "apartment", label: "Apartment" },
];

const EXAMPLES = [
  "Properties under $300,000 near Atlanta with at least $500 per month cash flow",
  "Houses in ZIP code 30269 with the highest cash-on-cash return",
  "Best Airbnb investment opportunities under $400,000 in Florida",
  "Properties in Georgia with at least 8% gross long-term rental yield",
];

interface SmartProps {
  onApply: (filters: SearchFilters, sort: SortKey | null) => void;
}

/** Natural-language search: shows exactly how the request was interpreted before running it. */
export function SmartSearch({ onApply }: SmartProps) {
  const [query, setQuery] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<NLParseResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length < 3) return;
    setBusy(true);
    setError(null);
    try {
      const parsed = await api.parseQuery(trimmed);
      setResult(parsed);
      if (parsed.valid) onApply(parsed.filters as SearchFilters, (parsed.sort as SortKey | null) ?? null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2.5">
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(query);
        }}
      >
        <div className="relative flex-1">
          <Sparkles className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            aria-label="Describe the investment you are looking for"
            placeholder="Describe what you're looking for — e.g. houses under $300k near Atlanta with $500/mo cash flow"
            value={query}
            maxLength={500}
            onChange={(event) => setQuery(event.target.value)}
            className="h-11 pl-9 text-[15px]"
          />
        </div>
        <Button type="submit" size="lg" disabled={busy || query.trim().length < 3} className="h-11">
          <Sparkles /> {busy ? "Interpreting…" : "Smart search"}
        </Button>
      </form>

      {!result && !error ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Try:</span>
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => {
                setQuery(example);
                void submit(example);
              }}
              className="rounded-full border bg-card px-2.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              {example}
            </button>
          ))}
        </div>
      ) : null}

      {error ? <Alert tone="error">{error}</Alert> : null}

      {result ? (
        <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Interpreted as</span>
            {result.interpreted.length ? result.interpreted.map((item) => <Badge key={item}>{item}</Badge>) : <span className="text-xs text-muted-foreground">nothing recognisable</span>}
            <Badge tone="outline" className="ml-auto">
              {result.engine === "llm" ? "AI parser" : "Rule-based parser"}
            </Badge>
            <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label="Dismiss interpretation" onClick={() => setResult(null)}>
              <X className="size-3.5" />
            </button>
          </div>
          {result.unsupported.length ? (
            <Alert tone="warning" title="Some criteria could not be applied">
              <ul className="list-disc space-y-0.5 pl-4">
                {result.unsupported.map((item) => (
                  <li key={item.criterion}>
                    <span className="font-medium">{item.criterion}:</span> {item.reason}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {result.warnings.map((warning) => (
            <Alert key={warning} tone={result.valid ? "info" : "error"}>
              {warning}
            </Alert>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface PanelProps {
  initial: SearchFilters | null;
  onSearch: (filters: SearchFilters) => void;
  onReset: () => void;
  busy?: boolean;
  defaultAdvanced?: boolean;
  actions?: React.ReactNode;
}

export function SearchPanel({ initial, onSearch, onReset, busy, defaultAdvanced = false, actions }: PanelProps) {
  const [form, setForm] = React.useState<FilterForm>(() => filtersToForm(initial));
  const [advanced, setAdvanced] = React.useState(defaultAdvanced);
  const [error, setError] = React.useState<string | null>(null);
  const { data: status } = useStatus();
  const initialKey = JSON.stringify(initial ?? null);

  React.useEffect(() => {
    setForm(filtersToForm(initial));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKey]);

  const set = <K extends keyof FilterForm>(key: K, value: FilterForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const advancedCount = [form.minNetYield, form.minCapRate, form.minCashOnCash, form.minCashFlow, form.maxBeds, form.maxHoa, form.maxDom, form.county || null, form.radius].filter(
    (v) => v !== null && v !== undefined && v !== "",
  ).length;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const filters = formToFilters(form);
    if (!hasLocation(filters)) {
      setError("Enter a ZIP code, a city (e.g. “Atlanta, GA”), or choose a state to search.");
      return;
    }
    const badZip = (filters.zip_codes ?? []).find((zip) => !/^\d{5}$/.test(zip));
    if (badZip) {
      setError(`“${badZip}” is not a 5-digit ZIP code.`);
      return;
    }
    if (filters.county && !filters.state) {
      setError("Choose a state for the county search.");
      return;
    }
    if (form.minPrice !== null && form.maxPrice !== null && form.minPrice > form.maxPrice) {
      setError("Minimum price is higher than maximum price.");
      return;
    }
    setError(null);
    onSearch(filters);
  };

  return (
    <Card className="p-4 sm:p-5">
      <form onSubmit={submit} className="space-y-4" aria-label="Property search filters">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
          <Field label="City" htmlFor="f-cities" className="col-span-2" hint="“City, ST”; separate several with ;">
            <Input id="f-cities" placeholder="Atlanta, GA" value={form.cities} onChange={(e) => set("cities", e.target.value)} autoComplete="off" />
          </Field>
          <Field label="ZIP code(s)" htmlFor="f-zips" className="col-span-2 md:col-span-1" hint="Comma-separated">
            <Input id="f-zips" placeholder="30269" inputMode="numeric" value={form.zips} onChange={(e) => set("zips", e.target.value)} autoComplete="off" />
          </Field>
          <Field label="State" htmlFor="f-state">
            <Select id="f-state" value={form.state} onChange={(e) => set("state", e.target.value)}>
              <option value="">Any</option>
              {US_STATES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Min price" htmlFor="f-min-price">
            <NumberInput id="f-min-price" prefix="$" placeholder="150,000" value={form.minPrice} onValueChange={(v) => set("minPrice", v)} min={0} />
          </Field>
          <Field label="Max price" htmlFor="f-max-price">
            <NumberInput id="f-max-price" prefix="$" placeholder="400,000" value={form.maxPrice} onValueChange={(v) => set("maxPrice", v)} min={0} />
          </Field>
          <Field label="Min gross yield" htmlFor="f-gross">
            <NumberInput id="f-gross" suffix="%" placeholder="8" value={form.minGrossYield} onValueChange={(v) => set("minGrossYield", v)} />
          </Field>
          <Field label="Min beds" htmlFor="f-min-beds">
            <NumberInput id="f-min-beds" placeholder="Any" value={form.minBeds} onValueChange={(v) => set("minBeds", v === null ? null : Math.round(v))} min={0} />
          </Field>
        </div>

        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <fieldset>
            <legend className="mb-1.5 text-xs font-medium text-muted-foreground">Rental strategy</legend>
            <div className="inline-flex rounded-lg bg-muted p-1" role="radiogroup" aria-label="Rental strategy">
              {(
                [
                  ["both", "Both"],
                  ["ltr", "Long-term"],
                  ["str", "Short-term"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={form.strategy === value}
                  onClick={() => set("strategy", value)}
                  className={cn("rounded-md px-3 py-1 text-sm font-medium transition-colors", form.strategy === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
                >
                  {label}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="min-w-0">
            <legend className="mb-1.5 text-xs font-medium text-muted-foreground">Property type</legend>
            <div className="flex flex-wrap gap-1.5">
              {PROPERTY_TYPES.map(({ value, label }) => {
                const on = form.propertyTypes.includes(value);
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={on}
                    onClick={() => set("propertyTypes", on ? form.propertyTypes.filter((t) => t !== value) : [...form.propertyTypes, value])}
                    className={cn("rounded-full border px-2.5 py-1 text-xs font-medium transition-colors", on ? "border-primary bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:text-foreground")}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </fieldset>
        </div>

        <div>
          <button type="button" onClick={() => setAdvanced((open) => !open)} aria-expanded={advanced} className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
            <ChevronDown className={cn("size-4 transition-transform", advanced && "rotate-180")} aria-hidden />
            More filters
            {advancedCount > 0 ? <Badge tone="solid">{advancedCount}</Badge> : null}
          </button>
          {advanced ? (
            <div className="mt-3 grid grid-cols-2 gap-3 border-t pt-4 md:grid-cols-4 xl:grid-cols-8">
              <Field label="County" htmlFor="f-county" className="col-span-2 md:col-span-1" hint="Needs a state">
                <Input id="f-county" placeholder="Fulton" value={form.county} onChange={(e) => set("county", e.target.value)} autoComplete="off" />
              </Field>
              <Field label="Search radius" htmlFor="f-radius" hint="Around the city or ZIP">
                <NumberInput id="f-radius" suffix="mi" placeholder="—" value={form.radius} onValueChange={(v) => set("radius", v)} min={0} max={100} />
              </Field>
              <Field label="Min net yield" htmlFor="f-net">
                <NumberInput id="f-net" suffix="%" value={form.minNetYield} onValueChange={(v) => set("minNetYield", v)} />
              </Field>
              <Field label="Min cap rate" htmlFor="f-cap">
                <NumberInput id="f-cap" suffix="%" value={form.minCapRate} onValueChange={(v) => set("minCapRate", v)} />
              </Field>
              <Field label="Min cash-on-cash" htmlFor="f-coc">
                <NumberInput id="f-coc" suffix="%" value={form.minCashOnCash} onValueChange={(v) => set("minCashOnCash", v)} />
              </Field>
              <Field label="Min cash flow" htmlFor="f-cf" hint="Per month">
                <NumberInput id="f-cf" prefix="$" value={form.minCashFlow} onValueChange={(v) => set("minCashFlow", v)} />
              </Field>
              <Field label="Max beds" htmlFor="f-max-beds">
                <NumberInput id="f-max-beds" placeholder="Any" value={form.maxBeds} onValueChange={(v) => set("maxBeds", v === null ? null : Math.round(v))} min={0} />
              </Field>
              <Field label="Max HOA" htmlFor="f-hoa" hint="Per month">
                <NumberInput id="f-hoa" prefix="$" value={form.maxHoa} onValueChange={(v) => set("maxHoa", v)} min={0} />
              </Field>
              <Field label="Max days on market" htmlFor="f-dom">
                <NumberInput id="f-dom" placeholder="Any" value={form.maxDom} onValueChange={(v) => set("maxDom", v === null ? null : Math.round(v))} min={0} />
              </Field>
              <p className="col-span-2 self-end text-[11px] leading-relaxed text-muted-foreground md:col-span-3 xl:col-span-7">
                Yield, cap rate, cash-on-cash and cash-flow filters use returns calculated with your financing assumptions (Settings) for the selected strategy. With “Both”, each
                property is tested on its recommended strategy.
              </p>
            </div>
          ) : null}
        </div>

        {error ? <Alert tone="error">{error}</Alert> : null}
        {form.polygon?.length ? (
          <Alert tone="info">
            A drawn map area with {form.polygon.length} points is part of this search.{" "}
            <button type="button" className="font-medium underline" onClick={() => set("polygon", null)}>
              Remove it
            </button>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={busy}>
            <Search /> {busy ? "Searching…" : "Search"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setForm({ ...EMPTY_FORM });
              setError(null);
              onReset();
            }}
          >
            <RotateCcw /> Reset filters
          </Button>
          {actions}
          {status?.data_mode === "demo" ? (
            <span className="ml-auto text-[11px] text-muted-foreground">
              Demo markets: {status.demo_markets.slice(0, 6).map((m) => `${m.city}, ${m.state}`).join(" · ")}
              {status.demo_markets.length > 6 ? ` · +${status.demo_markets.length - 6} more` : ""}
            </span>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
