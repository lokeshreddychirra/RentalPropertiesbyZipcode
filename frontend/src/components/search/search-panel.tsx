"use client";

import * as React from "react";
import { MapPin, Search, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card } from "@/components/ui/card";
import { Field, Input, NumberInput, Select } from "@/components/ui/form";
import { EMPTY_FORM, filtersToForm, formToFilters, hasLocation, parseLocation, type FilterForm } from "@/lib/filters";
import { useStatus } from "@/lib/store";
import type { SearchFilters, StrategyFilter } from "@/lib/types";
import { cn } from "@/lib/utils";

const PROPERTY_TYPES: { value: string; label: string }[] = [
  { value: "single_family", label: "Single family" },
  { value: "condo", label: "Condo" },
  { value: "townhouse", label: "Townhouse" },
  { value: "multi_family", label: "Multi-family" },
  { value: "manufactured", label: "Manufactured" },
];

const STRATEGIES: [StrategyFilter, string][] = [
  ["both", "Both strategies"],
  ["ltr", "Long-term rental"],
  ["str", "Short-term rental"],
];

interface PanelProps {
  initial: SearchFilters | null;
  onSearch: (filters: SearchFilters) => void;
  onReset: () => void;
  busy?: boolean;
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">{children}</div>
    </div>
  );
}

export function SearchPanel({ initial, onSearch, onReset, busy }: PanelProps) {
  const [form, setForm] = React.useState<FilterForm>(() => filtersToForm(initial));
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { data: status } = useStatus();
  const initialKey = JSON.stringify(initial ?? null);

  React.useEffect(() => {
    setForm(filtersToForm(initial));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKey]);

  const set = <K extends keyof FilterForm>(key: K, value: FilterForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const extraCount = [
    form.minPrice,
    form.maxBeds,
    form.maxHoa,
    form.maxDom,
    form.minGrossYield,
    form.minNetYield,
    form.minCapRate,
    form.minCashOnCash,
    form.minCashFlow,
    form.county || null,
    form.radius,
    form.propertyTypes.length || null,
  ].filter((v) => v !== null && v !== undefined && v !== "").length;
  const dirty = JSON.stringify(form) !== JSON.stringify(EMPTY_FORM);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const location = parseLocation(form.location);
    if (location.error) {
      setError(location.error);
      return;
    }
    const filters = formToFilters(form);
    if (!hasLocation(filters)) {
      setError("Enter a city and state (e.g. “Memphis, TN”), a ZIP code, or a state.");
      return;
    }
    if (filters.county && !filters.state) {
      setError("A county search needs a state in the location box — e.g. “TN” with county “Shelby”.");
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
    <Card className="overflow-hidden">
      <form onSubmit={submit} aria-label="Property search">
        <div className="flex flex-col gap-3 p-4 sm:p-5 lg:flex-row lg:items-end">
          <Field label="Location" htmlFor="f-location" className="min-w-0 flex-1">
            <div className="relative">
              <MapPin className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                id="f-location"
                placeholder="City, ZIP code or state — e.g. Memphis, TN or 38116"
                value={form.location}
                onChange={(e) => set("location", e.target.value)}
                autoComplete="off"
                className="h-11 pl-9 text-[15px]"
              />
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-3 lg:flex">
            <Field label="Max price" htmlFor="f-max-price" className="lg:w-40">
              <NumberInput id="f-max-price" prefix="$" placeholder="No max" value={form.maxPrice} onValueChange={(v) => set("maxPrice", v)} min={0} className="h-11" />
            </Field>
            <Field label="Bedrooms" htmlFor="f-min-beds" className="lg:w-32">
              <Select id="f-min-beds" value={form.minBeds ?? ""} onChange={(e) => set("minBeds", e.target.value === "" ? null : Number(e.target.value))} className="h-11">
                <option value="">Any</option>
                {[1, 2, 3, 4, 5].map((beds) => (
                  <option key={beds} value={beds}>
                    {beds}+
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button type="submit" size="lg" disabled={busy} className="h-11 lg:w-36">
            <Search /> {busy ? "Searching…" : "Search"}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-4 py-2.5 sm:px-5">
          <div className="inline-flex rounded-lg bg-muted p-0.5" role="radiogroup" aria-label="Rental strategy">
            {STRATEGIES.map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={form.strategy === value}
                onClick={() => set("strategy", value)}
                className={cn(
                  "rounded-md px-3 py-1 text-xs font-medium transition-colors sm:text-sm",
                  form.strategy === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls="search-filters">
            <SlidersHorizontal /> Filters
            {extraCount > 0 ? <Badge tone="solid">{extraCount}</Badge> : null}
          </Button>
          {dirty ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => {
                setForm({ ...EMPTY_FORM });
                setError(null);
                onReset();
              }}
            >
              <X /> Clear
            </Button>
          ) : null}
          {status?.data_mode === "demo" ? (
            <span className="ml-auto hidden text-[11px] text-muted-foreground md:inline">
              Demo markets: {status.demo_markets.slice(0, 5).map((m) => `${m.city}, ${m.state}`).join(" · ")}
              {status.demo_markets.length > 5 ? ` · +${status.demo_markets.length - 5} more` : ""}
            </span>
          ) : null}
        </div>

        {open ? (
          <div id="search-filters" className="space-y-5 border-t p-4 sm:p-5">
            <Group title="Property">
              <Field label="Min price" htmlFor="f-min-price">
                <NumberInput id="f-min-price" prefix="$" placeholder="No min" value={form.minPrice} onValueChange={(v) => set("minPrice", v)} min={0} />
              </Field>
              <Field label="Max bedrooms" htmlFor="f-max-beds">
                <NumberInput id="f-max-beds" placeholder="Any" value={form.maxBeds} onValueChange={(v) => set("maxBeds", v === null ? null : Math.round(v))} min={0} />
              </Field>
              <Field label="Max HOA / month" htmlFor="f-hoa">
                <NumberInput id="f-hoa" prefix="$" placeholder="Any" value={form.maxHoa} onValueChange={(v) => set("maxHoa", v)} min={0} />
              </Field>
              <Field label="Max days on market" htmlFor="f-dom">
                <NumberInput id="f-dom" placeholder="Any" value={form.maxDom} onValueChange={(v) => set("maxDom", v === null ? null : Math.round(v))} min={0} />
              </Field>
              <fieldset className="col-span-2 sm:col-span-3 lg:col-span-5">
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
                        className={cn(
                          "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                          on ? "border-primary bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            </Group>
            <Group title="Minimum returns">
              <Field label="Gross yield" htmlFor="f-gross">
                <NumberInput id="f-gross" suffix="%" placeholder="Any" value={form.minGrossYield} onValueChange={(v) => set("minGrossYield", v)} />
              </Field>
              <Field label="Cash flow / month" htmlFor="f-cf">
                <NumberInput id="f-cf" prefix="$" placeholder="Any" value={form.minCashFlow} onValueChange={(v) => set("minCashFlow", v)} />
              </Field>
              <Field label="Cash-on-cash" htmlFor="f-coc">
                <NumberInput id="f-coc" suffix="%" placeholder="Any" value={form.minCashOnCash} onValueChange={(v) => set("minCashOnCash", v)} />
              </Field>
              <Field label="Cap rate" htmlFor="f-cap">
                <NumberInput id="f-cap" suffix="%" placeholder="Any" value={form.minCapRate} onValueChange={(v) => set("minCapRate", v)} />
              </Field>
              <Field label="Net yield" htmlFor="f-net">
                <NumberInput id="f-net" suffix="%" placeholder="Any" value={form.minNetYield} onValueChange={(v) => set("minNetYield", v)} />
              </Field>
            </Group>
            <Group title="Area">
              <Field label="Radius" htmlFor="f-radius" hint="Around the city or ZIP">
                <NumberInput id="f-radius" suffix="mi" placeholder="—" value={form.radius} onValueChange={(v) => set("radius", v)} min={0} max={100} />
              </Field>
              <Field label="County" htmlFor="f-county" hint="With a state as the location">
                <Input id="f-county" placeholder="e.g. Shelby" value={form.county} onChange={(e) => set("county", e.target.value)} autoComplete="off" />
              </Field>
            </Group>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Return filters are calculated with the financing assumptions (25% down at 7% by default) for each property’s recommended strategy.
            </p>
          </div>
        ) : null}

        {error || form.polygon?.length ? (
          <div className="space-y-2 border-t px-4 py-3 sm:px-5">
            {error ? <Alert tone="error">{error}</Alert> : null}
            {form.polygon?.length ? (
              <Alert tone="info">
                A drawn map area with {form.polygon.length} points is part of this search.{" "}
                <button type="button" className="font-medium underline" onClick={() => set("polygon", null)}>
                  Remove it
                </button>
              </Alert>
            ) : null}
          </div>
        ) : null}
      </form>
    </Card>
  );
}
