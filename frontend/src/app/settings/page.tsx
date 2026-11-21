"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { LocationBox } from "@/components/search/location-box";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from "@/components/ui/card";
import { Field, NumberInput, Select } from "@/components/ui/form";
import { Check, LayoutGrid, LocateFixed, Map as MapIcon, MapPin, RotateCcw, Table2 } from "@/components/ui/icons";
import { api, errorMessage } from "@/lib/api";
import { SORT_OPTIONS } from "@/lib/filters";
import { currentPosition, LocationError } from "@/lib/geo";
import { useApp, useSession } from "@/lib/store";
import type { AssumptionOverrides, DefaultFilters, MapPlace, ScoreWeights, SearchDefaults, SortKey } from "@/lib/types";
import { cn } from "@/lib/utils";

const PROPERTY_TYPES: { value: string; label: string }[] = [
  { value: "single_family", label: "Single family" },
  { value: "condo", label: "Condo" },
  { value: "townhouse", label: "Townhouse" },
  { value: "multi_family", label: "Multifamily" },
  { value: "manufactured", label: "Manufactured" },
];

const VIEWS = [
  { value: "list", label: "List", icon: LayoutGrid },
  { value: "map", label: "Map", icon: MapIcon },
  { value: "table", label: "Table", icon: Table2 },
] as const;

type Filters = Record<string, unknown>;
type Overrides = Record<string, Record<string, number | null | undefined>>;
type Weights = Record<string, number>;

/** Assumption fields shown on this page, grouped. Empty means "use the app's default". */
const ASSUMPTION_GROUPS: { title: string; description: string; fields: { section: string; name: string; label: string; suffix?: string; prefix?: string; choices?: number[]; hint?: string }[] }[] = [
  {
    title: "Financing",
    description: "How you usually buy. Used for the mortgage payment, cash flow and cash on cash return of every home.",
    fields: [
      { section: "financing", name: "down_payment_pct", label: "Down payment", suffix: "%", hint: "100% means an all cash purchase." },
      { section: "financing", name: "interest_rate_pct", label: "Interest rate", suffix: "%" },
      { section: "financing", name: "loan_term_years", label: "Loan term", choices: [15, 20, 30] },
      { section: "acquisition", name: "closing_cost_pct", label: "Closing costs", suffix: "% of price" },
    ],
  },
  {
    title: "Running costs",
    description: "What owning and renting out a home costs you each year.",
    fields: [
      { section: "fixed", name: "property_tax_rate_pct", label: "Property tax", suffix: "% of price / yr", hint: "Used when a home has no tax record." },
      { section: "fixed", name: "insurance_rate_pct", label: "Insurance", suffix: "% of price / yr" },
      { section: "long_term", name: "vacancy_pct", label: "Vacancy", suffix: "% of rent" },
      { section: "long_term", name: "management_pct", label: "Property management", suffix: "% of rent", hint: "Set 0 if you manage it yourself." },
      { section: "long_term", name: "maintenance_pct", label: "Maintenance", suffix: "% of rent" },
      { section: "long_term", name: "capex_pct", label: "Capital reserve", suffix: "% of rent", hint: "Roof, HVAC and other big replacements." },
    ],
  },
  {
    title: "Growth",
    description: "Used for the long term projections on each property.",
    fields: [
      { section: "forecast", name: "rent_growth_pct", label: "Rent growth", suffix: "% / yr" },
      { section: "forecast", name: "appreciation_pct", label: "Home value growth", suffix: "% / yr" },
      { section: "forecast", name: "expense_inflation_pct", label: "Cost inflation", suffix: "% / yr" },
    ],
  },
];

const RETURN_FIELDS: { key: string; label: string; prefix?: string; suffix?: string }[] = [
  { key: "min_cash_flow", label: "Min cash flow / mo", prefix: "$" },
  { key: "min_cash_on_cash", label: "Min cash on cash", suffix: "%" },
  { key: "min_cap_rate", label: "Min cap rate", suffix: "%" },
  { key: "min_gross_yield", label: "Min gross yield", suffix: "%" },
  { key: "min_net_yield", label: "Min net yield", suffix: "%" },
];

const num = (value: unknown): number | null => (value === null || value === undefined || value === "" ? null : Number(value));

function Section({ title, description, children, id }: { title: string; description: string; children: React.ReactNode; id?: string }) {
  return (
    <Card id={id}>
      <CardHeader>
        <CardTitle className="title-2">{title}</CardTitle>
        <CardDescription className="text-pretty">{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function SettingsContent() {
  const app = useApp();
  const { user } = useSession();
  const meta = useQuery({ queryKey: ["meta"], queryFn: api.meta, staleTime: Infinity });
  const appDefaults = (meta.data?.default_assumptions ?? {}) as Record<string, Record<string, unknown>>;
  const appWeights = (meta.data?.default_weights ?? {}) as Record<string, number>;
  const weightLabels = (meta.data?.weight_labels ?? {}) as Record<string, string>;

  // Editable copies; nothing is applied until "Save settings".
  const [filters, setFilters] = React.useState<Filters>({});
  const [sort, setSort] = React.useState<string>("");
  const [view, setView] = React.useState<string>("");
  const [mapPlace, setMapPlace] = React.useState<MapPlace | null>(null);
  const [placeText, setPlaceText] = React.useState("");
  const [overrides, setOverrides] = React.useState<Overrides>({});
  const [weights, setWeights] = React.useState<Weights | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [locating, setLocating] = React.useState(false);

  const load = React.useCallback(() => {
    const s = app.searchDefaults;
    setFilters({ ...((s.filters ?? {}) as Filters) });
    setSort(s.sort ?? "");
    setView(s.view ?? "");
    setMapPlace(s.map_place ?? null);
    setPlaceText(s.map_place?.label ?? "");
    setOverrides(JSON.parse(JSON.stringify(app.defaults ?? {})) as Overrides);
    setWeights(app.weights ? ({ ...app.weights } as Weights) : null);
  }, [app.searchDefaults, app.defaults, app.weights]);

  const loadedKey = JSON.stringify([app.searchDefaults, app.defaults, app.weights]);
  React.useEffect(() => {
    if (app.hydrated) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.hydrated, loadedKey]);

  const draft = React.useMemo(() => {
    const searchDefaults: SearchDefaults = {
      filters: filters as DefaultFilters,
      sort: (sort || null) as SortKey | null,
      view: (view || null) as SearchDefaults["view"],
      map_place: mapPlace,
    };
    return { searchDefaults, defaults: overrides as AssumptionOverrides, weights: weights as ScoreWeights | null };
  }, [filters, sort, view, mapPlace, overrides, weights]);

  const normalise = (value: unknown) =>
    JSON.stringify(value, (_, v) => (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length) ? undefined : v)) ?? "";
  const changed =
    normalise(draft.searchDefaults) !== normalise(app.searchDefaults) ||
    normalise(draft.defaults) !== normalise(app.defaults) ||
    normalise(draft.weights) !== normalise(app.weights);

  const setFilter = (key: string, value: unknown) => setFilters((current) => ({ ...current, [key]: value }));
  const setOverride = (section: string, name: string, value: number | null) =>
    setOverrides((current) => ({ ...current, [section]: { ...(current[section] ?? {}), [name]: value } }));
  const types = (filters.property_types as string[] | undefined) ?? [];

  const minMaxError =
    num(filters.min_price) != null && num(filters.max_price) != null && num(filters.min_price)! > num(filters.max_price)!
      ? "The minimum price is higher than the maximum price."
      : num(filters.min_beds) != null && num(filters.max_beds) != null && num(filters.min_beds)! > num(filters.max_beds)!
        ? "The minimum bedrooms is higher than the maximum."
        : num(filters.min_year_built) != null && num(filters.max_year_built) != null && num(filters.min_year_built)! > num(filters.max_year_built)!
          ? "“Built from” is later than “built to”."
          : weights && Object.values(weights).every((w) => !w)
            ? "At least one score weight must be above zero."
            : null;

  const save = async () => {
    if (minMaxError) return toast.error(minMaxError);
    setSaving(true);
    try {
      await app.saveSettings(draft);
      toast.success(user ? "Settings saved. Every new search will use them." : "Settings saved on this device. Every new search will use them.");
    } catch (error) {
      toast.error(`Your settings could not be saved: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const resetAll = () => {
    setFilters({});
    setSort("");
    setView("");
    setMapPlace(null);
    setPlaceText("");
    setOverrides({});
    setWeights(null);
  };

  const locateMe = async () => {
    setLocating(true);
    try {
      const here = await currentPosition();
      const hit = await api.zipAt(here.latitude, here.longitude).catch(() => null);
      const label = hit?.place ?? (hit?.zip_code ? `ZIP ${hit.zip_code}` : "My saved location");
      setMapPlace({ label, latitude: here.latitude, longitude: here.longitude });
      setPlaceText(label);
    } catch (error) {
      toast.error(error instanceof LocationError ? error.message : "Your location could not be found.");
    } finally {
      setLocating(false);
    }
  };

  if (!app.hydrated) return <Skeleton className="h-[480px] w-full" />;

  return (
    <div className="space-y-6">
      {!user ? (
        <Card className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <p className="text-sm text-muted-foreground">These settings are saved on this device. Sign in to keep them on every device.</p>
          <Button asChild size="sm" variant="outline">
            <Link href="/login?next=/settings">Sign in</Link>
          </Button>
        </Card>
      ) : null}

      <Section id="filters" title="Search filters" description="Every new search starts with these filters. You can still change them for a single search with the filter buttons under the search box.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Price" htmlFor="s-min-price">
            <div className="grid grid-cols-2 gap-2">
              <NumberInput id="s-min-price" aria-label="Minimum price" prefix="$" placeholder="No min" min={0} value={num(filters.min_price)} onValueChange={(v) => setFilter("min_price", v)} />
              <NumberInput aria-label="Maximum price" prefix="$" placeholder="No max" min={0} value={num(filters.max_price)} onValueChange={(v) => setFilter("max_price", v)} />
            </div>
          </Field>
          <Field label="Bedrooms" htmlFor="s-min-beds">
            <div className="grid grid-cols-2 gap-2">
              <Select id="s-min-beds" aria-label="Minimum bedrooms" value={num(filters.min_beds) ?? ""} onChange={(e) => setFilter("min_beds", e.target.value === "" ? null : Number(e.target.value))}>
                <option value="">Any min</option>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}+
                  </option>
                ))}
              </Select>
              <Select aria-label="Maximum bedrooms" value={num(filters.max_beds) ?? ""} onChange={(e) => setFilter("max_beds", e.target.value === "" ? null : Number(e.target.value))}>
                <option value="">Any max</option>
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    Up to {n}
                  </option>
                ))}
              </Select>
            </div>
          </Field>
          <Field label="Year built" htmlFor="s-min-year">
            <div className="grid grid-cols-2 gap-2">
              <NumberInput id="s-min-year" aria-label="Built from" placeholder="From any" min={1700} max={2100} value={num(filters.min_year_built)} onValueChange={(v) => setFilter("min_year_built", v === null ? null : Math.round(v))} />
              <NumberInput aria-label="Built to" placeholder="To any" min={1700} max={2100} value={num(filters.max_year_built)} onValueChange={(v) => setFilter("max_year_built", v === null ? null : Math.round(v))} />
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Max HOA / mo" htmlFor="s-hoa">
              <NumberInput id="s-hoa" prefix="$" placeholder="Any" min={0} value={num(filters.max_hoa)} onValueChange={(v) => setFilter("max_hoa", v)} />
            </Field>
            <Field label="Max days listed" htmlFor="s-dom">
              <NumberInput id="s-dom" placeholder="Any" min={0} value={num(filters.max_days_on_market)} onValueChange={(v) => setFilter("max_days_on_market", v === null ? null : Math.round(v))} />
            </Field>
          </div>
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium">Home types</p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Home types">
            {PROPERTY_TYPES.map(({ value, label }) => {
              const on = types.includes(value);
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setFilter("property_types", on ? types.filter((t) => t !== value) : [...types, value])}
                  className={cn(
                    "caption-4 inline-flex h-8 items-center gap-1 rounded-full border px-3 transition-[color,background-color,border-color]",
                    on ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted",
                  )}
                >
                  {on ? <Check className="size-3.5" aria-hidden /> : null}
                  {label}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">None selected means every home type.</p>
        </div>
      </Section>

      <Section id="returns" title="Minimum returns" description="Hide homes that do not reach these numbers. Leave a box empty to show every home.">
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {RETURN_FIELDS.map((field) => (
            <Field key={field.key} label={field.label} htmlFor={`s-${field.key}`}>
              <NumberInput id={`s-${field.key}`} prefix={field.prefix} suffix={field.suffix} placeholder="Any" value={num(filters[field.key])} onValueChange={(v) => setFilter(field.key, v)} />
            </Field>
          ))}
        </div>
      </Section>

      <Section id="results" title="Results" description="How results are ordered and shown when a search opens.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Sort by" htmlFor="s-sort">
            <Select id="s-sort" value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="">Best overall score (default)</option>
              {SORT_OPTIONS.filter((o) => o.value !== "score").map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Show results as" htmlFor="s-view">
            <div>
            <div id="s-view" className="inline-flex rounded-xl border bg-muted p-1" role="radiogroup" aria-label="Show results as">
              {VIEWS.map(({ value, label, icon: Icon }) => {
                const on = (view || "list") === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setView(value === "list" ? "" : value)}
                    className={cn("button-sm inline-flex h-8 items-center gap-2 rounded-lg px-3", on ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
                  >
                    <Icon className="size-4" aria-hidden /> {label}
                  </button>
                );
              })}
            </div>
            </div>
          </Field>
        </div>
      </Section>

      <Section id="map" title="Dashboard map" description="Where the map on the dashboard opens before you search.">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Map start">
            {[
              { on: !mapPlace, label: "My current location", icon: LocateFixed, pick: () => { setMapPlace(null); setPlaceText(""); } },
              { on: !!mapPlace, label: "A place I choose", icon: MapPin, pick: () => document.getElementById("f-location")?.focus() },
            ].map(({ on, label, icon: Icon, pick }) => (
              <button
                key={label}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={pick}
                className={cn("caption-4 inline-flex h-9 items-center gap-2 rounded-full border px-3", on ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted")}
              >
                <Icon className="size-4" aria-hidden /> {label}
              </button>
            ))}
          </div>
          <div className="max-w-xl">
            <LocationBox
              value={placeText}
              onChange={setPlaceText}
              onPick={(place) => {
                setMapPlace({ label: place.label, latitude: place.latitude, longitude: place.longitude });
                setPlaceText(place.label);
              }}
              onLocate={() => void locateMe()}
              locating={locating}
            />
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              {mapPlace ? `The map opens at ${mapPlace.label}.` : "Type a city or ZIP code and pick it from the list, or leave it to open where you are."}
            </p>
          </div>
        </div>
      </Section>

      {ASSUMPTION_GROUPS.map((group) => (
        <Section key={group.title} id={group.title.toLowerCase().replace(/\s+/g, "-")} title={group.title} description={`${group.description} Leave a box empty to use the app default.`}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {group.fields.map((field) => {
              const value = num(overrides[field.section]?.[field.name]);
              const fallback = num(appDefaults[field.section]?.[field.name]);
              const id = `s-${field.section}-${field.name}`;
              return (
                <Field key={id} label={field.label} htmlFor={id} hint={field.hint ?? (fallback != null ? `App default ${fallback}${field.suffix?.startsWith("%") ? "%" : field.choices ? " years" : ""}` : undefined)}>
                  {field.choices ? (
                    <Select id={id} value={value ?? ""} onChange={(e) => setOverride(field.section, field.name, e.target.value === "" ? null : Number(e.target.value))}>
                      <option value="">{fallback != null ? `${fallback} years (default)` : "Default"}</option>
                      {field.choices.filter((c) => c !== fallback).map((c) => (
                        <option key={c} value={c}>
                          {c} years
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <NumberInput
                      id={id}
                      suffix={field.suffix}
                      placeholder={fallback != null ? String(fallback) : "Default"}
                      min={0}
                      max={100}
                      value={value}
                      onValueChange={(v) => setOverride(field.section, field.name, v)}
                    />
                  )}
                </Field>
              );
            })}
          </div>
        </Section>
      ))}

      <Section id="score" title="Deal score" description="How much each part counts toward a home's score out of 100, which is the default ranking. Weights are relative: only their proportions matter.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Object.entries(appWeights).map(([key, fallback]) => (
            <Field key={key} label={weightLabels[key] ?? key} htmlFor={`s-w-${key}`}>
              <NumberInput
                id={`s-w-${key}`}
                min={0}
                max={100}
                placeholder={String(fallback)}
                value={weights ? (weights[key] ?? fallback) : null}
                onValueChange={(v) => setWeights((current) => ({ ...(current ?? appWeights), [key]: v ?? 0 }))}
              />
            </Field>
          ))}
        </div>
        {weights ? (
          <Button size="sm" variant="ghost" onClick={() => setWeights(null)}>
            <RotateCcw /> Use the default weights
          </Button>
        ) : null}
      </Section>

      <div className="glass-strong sticky bottom-20 z-20 flex flex-wrap items-center justify-between gap-3 rounded-2xl px-5 py-3 shadow-xl lg:bottom-4" data-testid="settings-bar">
        <p className="text-sm text-muted-foreground">{minMaxError ?? (changed ? "You have unsaved changes." : "New searches use these settings.")}</p>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={resetAll} disabled={saving}>
            <RotateCcw /> Reset all
          </Button>
          {changed ? (
            <Button variant="outline" onClick={load} disabled={saving}>
              Discard
            </Button>
          ) : null}
          <Button onClick={() => void save()} disabled={!changed || saving || !!minMaxError} data-testid="save-settings">
            <Check /> {saving ? "Saving…" : "Save settings"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 pb-24 pt-6 lg:px-6">
      <div>
        <h1 className="heading-4">Settings</h1>
        <p className="body-6 mt-1 max-w-2xl text-pretty text-muted-foreground">
          Set your filters and numbers once. Every new search uses them, and you can still change anything for a single search.
        </p>
      </div>
      <SettingsContent />
    </div>
  );
}
