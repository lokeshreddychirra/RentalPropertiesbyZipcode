"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown, Search, Settings, X } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Alert, Card } from "@/components/ui/card";
import { Field, NumberInput, Select } from "@/components/ui/form";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import { api } from "@/lib/api";
import { EMPTY_FORM, filtersToForm, formToFilters, isPlaceText, parseZips, type FilterForm } from "@/lib/filters";
import { currentPosition, LocationError } from "@/lib/geo";
import { useApp, useStatus } from "@/lib/store";
import type { PlaceSuggestion, SearchFilters } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CityZipPicker, LocationBox } from "./location-box";

const PROPERTY_TYPES: { value: string; label: string }[] = [
  { value: "single_family", label: "Single family" },
  { value: "condo", label: "Condo" },
  { value: "townhouse", label: "Townhouse" },
  { value: "multi_family", label: "Multifamily" },
  { value: "manufactured", label: "Manufactured" },
];


const money = (v: number) => (v >= 1_000_000 ? `$${+(v / 1_000_000).toFixed(2)}M` : v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${v}`);

function rangeLabel(min: number | null, max: number | null, fmt: (v: number) => string, prefix = ""): string | null {
  if (min != null && max != null) return `${prefix}${fmt(min)}–${fmt(max)}`;
  if (min != null) return `${prefix}${fmt(min)}+`;
  if (max != null) return `${prefix}up to ${fmt(max)}`;
  return null;
}

interface FilterButtonProps {
  label: string;
  /** Summary of the active value; when set the button is highlighted. */
  active: string | null;
  onApply: () => void;
  onClear: () => void;
  width?: string;
  children: React.ReactNode;
}

/** A compact filter chip that opens a small panel. "Apply" runs the search; "Clear" resets this filter. */
function FilterButton({ label, active, onApply, onClear, width, children }: FilterButtonProps) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "caption-4 inline-flex h-8 items-center gap-1 rounded-full border px-3 transition-[color,background-color,border-color,transform] active:scale-[0.98]",
            active ? "border-primary bg-primary text-primary-foreground" : "bg-card text-foreground hover:border-foreground/30 hover:bg-muted",
          )}
        >
          {active ?? label}
          <ChevronDown className="size-3.5 opacity-70" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className={width}>
        <div className="space-y-3">
          <p className="caption-3 text-muted-foreground">{label}</p>
          {children}
          <div className="flex justify-between gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={onClear} disabled={!active}>
              Clear
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setOpen(false);
                onApply();
              }}
            >
              Apply
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface PanelProps {
  initial: SearchFilters | null;
  onSearch: (filters: SearchFilters) => void;
  onReset: () => void;
  busy?: boolean;
}

export function SearchPanel({ initial, onSearch, onReset, busy }: PanelProps) {
  const { searchDefaults, defaults: assumptions, hydrated } = useApp();
  const defaultFilters = searchDefaults.filters as Partial<SearchFilters> | undefined;
  // A new search starts from the user's default filters (Settings); a running one shows its own.
  const startForm = React.useCallback(() => filtersToForm(initial ?? defaultFilters ?? null), [initial, defaultFilters]);
  const [form, setForm] = React.useState<FilterForm>(startForm);
  const [error, setError] = React.useState<string | null>(null);
  const [city, setCity] = React.useState<PlaceSuggestion | null>(null);
  const [locating, setLocating] = React.useState(false);
  const { data: status } = useStatus();
  const initialKey = JSON.stringify(initial ?? null);
  const defaultsKey = JSON.stringify(defaultFilters ?? null);
  const formRef = React.useRef(form);
  formRef.current = form;

  React.useEffect(() => {
    // Keep whatever is being typed when saved defaults arrive after the page loads.
    setForm((current) => ({ ...startForm(), location: initial ? startForm().location : current.location }));
    setError(null);
    setCity(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKey, defaultsKey, hydrated]);

  const set = <K extends keyof FilterForm>(key: K, value: FilterForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const dirty = JSON.stringify(form) !== JSON.stringify(EMPTY_FORM);
  const usingDefaults = !!defaultFilters && Object.keys(defaultFilters).length > 0;

  const checkRanges = (next: FilterForm): string | null => {
    if (next.minPrice != null && next.maxPrice != null && next.minPrice > next.maxPrice) return "The minimum price is higher than the maximum price.";
    if (next.minYear != null && next.maxYear != null && next.minYear > next.maxYear) return "“Built from” is later than “built to”.";
    return null;
  };

  /** Search one ZIP code (typed, suggested or found at the user's location). */
  const searchZip = (zip: string, next: FilterForm = formRef.current) => {
    setCity(null);
    setForm({ ...next, location: zip });
    onSearch({ ...formToFilters({ ...next, location: zip }) });
  };

  /** A city or ZIP code picked from the suggestions. */
  const pickPlace = (place: PlaceSuggestion) => {
    setError(null);
    if (place.kind === "postcode" && place.zip_code) return searchZip(place.zip_code);
    setForm((current) => ({ ...current, location: place.label }));
    setCity(place);
  };

  /** Validate and run the search with the given form (defaults to the current one). */
  const run = async (next: FilterForm = formRef.current, quiet = false) => {
    const rangeError = checkRanges(next);
    if (rangeError) return setError(rangeError);
    // A drawn map area or a city carries its own ZIP codes; keep them while only other filters change.
    const keep = !!(initial?.polygon?.length || initial?.place) && next.location === filtersToForm(initial).location;
    if (keep) {
      setError(null);
      return onSearch({ ...formToFilters(next), zip_codes: initial!.zip_codes, polygon: initial!.polygon ?? null, place: initial!.place ?? null });
    }
    const text = next.location.trim();
    if (!text) {
      if (!quiet) setError("Enter a ZIP code or a city, for example 38116 or Memphis, TN.");
      return;
    }
    if (isPlaceText(text)) {
      if (quiet) return; // filter chips only remember the choice until a city is picked
      if (city && city.label === text) return; // its ZIP codes are already showing
      try {
        const hits = await api.places(text);
        const hit = hits.find((h) => h.kind === "place") ?? hits[0];
        if (!hit) return setError(`We could not find “${text}”. Try a ZIP code, or a city with its state like Memphis, TN.`);
        pickPlace(hit);
      } catch {
        setError("Places could not be looked up right now. Try a ZIP code instead.");
      }
      return;
    }
    const parsed = parseZips(text);
    if (parsed.error) return setError(parsed.error);
    if (parsed.zip_codes.length > 1) return setError("Search one ZIP code at a time, or type a city to search several of its ZIP codes.");
    setError(null);
    searchZip(parsed.zip_codes[0], next);
  };

  const locate = async () => {
    setLocating(true);
    setError(null);
    try {
      const here = await currentPosition();
      const hit = await api.zipAt(here.latitude, here.longitude);
      if (!hit.zip_code) setError("We could not find a ZIP code at your location. Type a ZIP code or city instead.");
      else searchZip(hit.zip_code);
    } catch (err) {
      setError(err instanceof LocationError ? err.message : "Your location could not be looked up right now. Type a ZIP code or city instead.");
    } finally {
      setLocating(false);
    }
  };

  // Filter panels apply as soon as there is a ZIP code; without one they just remember the choice.
  const apply = (values?: Partial<FilterForm>) => {
    const next = values ? { ...formRef.current, ...values } : formRef.current;
    if (values) setForm(next);
    void run(next, true);
  };
  const down = Number(assumptions.financing?.down_payment_pct ?? 25);
  const rate = Number(assumptions.financing?.interest_rate_pct ?? 7);

  const returnsCount = [form.minGrossYield, form.minCashFlow, form.minCashOnCash, form.minCapRate, form.minNetYield].filter((v) => v != null).length;
  const moreCount = [form.maxHoa, form.maxDom].filter((v) => v != null).length;
  const types = form.propertyTypes;

  return (
    <Card>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
        aria-label="Property search"
        className="space-y-3 p-3"
      >
        <div className="flex gap-2">
          <LocationBox
            value={form.location}
            onChange={(value) => {
              set("location", value);
              if (city && value !== city.label) setCity(null);
            }}
            onPick={pickPlace}
            onLocate={locate}
            locating={locating}
          />
          <Button type="submit" size="lg" disabled={busy} className="h-12 px-4" aria-label={busy ? "Searching" : "Find deals"}>
            <Search /> <span className="hidden sm:inline">{busy ? "Searching…" : "Find deals"}</span>
          </Button>
        </div>

        {city ? (
          <CityZipPicker
            place={city}
            onCancel={() => setCity(null)}
            onSearch={(zips, label) => {
              setCity(null);
              setForm((current) => ({ ...current, location: label }));
              onSearch({ ...formToFilters(formRef.current), zip_codes: zips, place: label, polygon: null });
            }}
          />
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <FilterButton
            label="Price"
            active={rangeLabel(form.minPrice, form.maxPrice, money)}
            onApply={() => apply()}
            onClear={() => apply({ minPrice: null, maxPrice: null })}
          >
            <div className="grid grid-cols-2 gap-2">
              <Field label="Min" htmlFor="f-min-price">
                <NumberInput id="f-min-price" prefix="$" placeholder="No min" value={form.minPrice} onValueChange={(v) => set("minPrice", v)} min={0} />
              </Field>
              <Field label="Max" htmlFor="f-max-price">
                <NumberInput id="f-max-price" prefix="$" placeholder="No max" value={form.maxPrice} onValueChange={(v) => set("maxPrice", v)} min={0} />
              </Field>
            </div>
          </FilterButton>

          <FilterButton
            label="Beds"
            active={rangeLabel(form.minBeds, form.maxBeds, String)?.concat(" beds") ?? null}
            onApply={() => apply()}
            onClear={() => apply({ minBeds: null, maxBeds: null })}
          >
            <div className="grid grid-cols-2 gap-2">
              <Field label="Min" htmlFor="f-min-beds">
                <Select id="f-min-beds" value={form.minBeds ?? ""} onChange={(e) => set("minBeds", e.target.value === "" ? null : Number(e.target.value))}>
                  <option value="">Any</option>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Max" htmlFor="f-max-beds">
                <Select id="f-max-beds" value={form.maxBeds ?? ""} onChange={(e) => set("maxBeds", e.target.value === "" ? null : Number(e.target.value))}>
                  <option value="">Any</option>
                  {[1, 2, 3, 4, 5, 6].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </FilterButton>

          <FilterButton
            label="Home type"
            active={types.length ? (types.length === 1 ? PROPERTY_TYPES.find((t) => t.value === types[0])?.label ?? "1 type" : `${types.length} types`) : null}
            onApply={() => apply()}
            onClear={() => apply({ propertyTypes: [] })}
            width="w-60"
          >
            <div className="space-y-1">
              {PROPERTY_TYPES.map(({ value, label }) => (
                <label key={value} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 hover:bg-muted">
                  <input
                    type="checkbox"
                    checked={types.includes(value)}
                    onChange={() => set("propertyTypes", types.includes(value) ? types.filter((t) => t !== value) : [...types, value])}
                    className="accent-[hsl(var(--primary))]"
                  />
                  {label}
                </label>
              ))}
            </div>
          </FilterButton>

          <FilterButton
            label="Year built"
            active={rangeLabel(form.minYear, form.maxYear, String, "Built ")}
            onApply={() => apply()}
            onClear={() => apply({ minYear: null, maxYear: null })}
          >
            <div className="grid grid-cols-2 gap-2">
              <Field label="From" htmlFor="f-min-year">
                <NumberInput id="f-min-year" placeholder="Any" value={form.minYear} onValueChange={(v) => set("minYear", v === null ? null : Math.round(v))} min={1700} max={2100} />
              </Field>
              <Field label="To" htmlFor="f-max-year">
                <NumberInput id="f-max-year" placeholder="Any" value={form.maxYear} onValueChange={(v) => set("maxYear", v === null ? null : Math.round(v))} min={1700} max={2100} />
              </Field>
            </div>
            <p className="caption-5 text-muted-foreground">Homes with no recorded build year are hidden while this filter is on.</p>
          </FilterButton>

          <FilterButton
            label="Returns"
            active={returnsCount ? `Returns · ${returnsCount}` : null}
            onApply={() => apply()}
            onClear={() => apply({ minGrossYield: null, minCashFlow: null, minCashOnCash: null, minCapRate: null, minNetYield: null })}
            width="w-80"
          >
            <div className="grid grid-cols-2 gap-2">
              <Field label="Min gross yield" htmlFor="f-gross">
                <NumberInput id="f-gross" suffix="%" placeholder="Any" value={form.minGrossYield} onValueChange={(v) => set("minGrossYield", v)} />
              </Field>
              <Field label="Min cash flow / mo" htmlFor="f-cf">
                <NumberInput id="f-cf" prefix="$" placeholder="Any" value={form.minCashFlow} onValueChange={(v) => set("minCashFlow", v)} />
              </Field>
              <Field label="Min cash on cash" htmlFor="f-coc">
                <NumberInput id="f-coc" suffix="%" placeholder="Any" value={form.minCashOnCash} onValueChange={(v) => set("minCashOnCash", v)} />
              </Field>
              <Field label="Min cap rate" htmlFor="f-cap">
                <NumberInput id="f-cap" suffix="%" placeholder="Any" value={form.minCapRate} onValueChange={(v) => set("minCapRate", v)} />
              </Field>
              <Field label="Min net yield" htmlFor="f-net">
                <NumberInput id="f-net" suffix="%" placeholder="Any" value={form.minNetYield} onValueChange={(v) => set("minNetYield", v)} />
              </Field>
            </div>
            <p className="caption-5 text-pretty text-muted-foreground">
              Calculated with {down >= 100 ? "an all cash purchase" : `${down}% down at ${rate}%`} as a long term rental.{" "}
              <Link href="/settings" className="underline underline-offset-2 hover:text-foreground">
                Change in Settings
              </Link>
            </p>
          </FilterButton>

          <FilterButton
            label="More"
            active={moreCount ? `More · ${moreCount}` : null}
            onApply={() => apply()}
            onClear={() => apply({ maxHoa: null, maxDom: null })}
          >
            <div className="grid grid-cols-2 gap-2">
              <Field label="Max HOA / mo" htmlFor="f-hoa">
                <NumberInput id="f-hoa" prefix="$" placeholder="Any" value={form.maxHoa} onValueChange={(v) => set("maxHoa", v)} min={0} />
              </Field>
              <Field label="Max days listed" htmlFor="f-dom">
                <NumberInput id="f-dom" placeholder="Any" value={form.maxDom} onValueChange={(v) => set("maxDom", v === null ? null : Math.round(v))} min={0} />
              </Field>
            </div>
          </FilterButton>

          {dirty ? (
            <button
              type="button"
              className="caption-4 inline-flex h-8 items-center gap-1 rounded-full px-2 text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => {
                setForm({ ...EMPTY_FORM });
                setError(null);
                setCity(null);
                onReset();
              }}
            >
              <X className="size-3.5" aria-hidden /> Clear all
            </button>
          ) : null}

          {usingDefaults ? (
            <Link
              href="/settings"
              className="caption-4 inline-flex h-8 items-center gap-1 rounded-full px-2 text-muted-foreground transition-colors hover:text-foreground"
              title="New searches start with the filters saved in Settings"
              data-testid="defaults-link"
            >
              <Settings className="size-3.5" aria-hidden /> Your default filters
            </Link>
          ) : null}

          {status?.data_mode === "demo" ? (
            <span className="caption-5 ml-auto hidden text-muted-foreground lg:inline">
              Demo ZIPs: {status.demo_markets.slice(0, 4).map((m) => `${m.zip_codes.split(",")[0]} ${m.city}`).join(" · ")}
            </span>
          ) : null}
        </div>

        {error ? <Alert tone="error">{error}</Alert> : null}
      </form>
    </Card>
  );
}
