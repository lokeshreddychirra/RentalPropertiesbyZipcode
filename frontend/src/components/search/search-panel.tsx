"use client";

import * as React from "react";
import { ChevronDown, MapPin, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Card } from "@/components/ui/card";
import { Field, Input, NumberInput, Select } from "@/components/ui/form";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import { EMPTY_FORM, filtersToForm, formToFilters, parseZips, type FilterForm } from "@/lib/filters";
import { useStatus } from "@/lib/store";
import type { SearchFilters } from "@/lib/types";
import { cn } from "@/lib/utils";

const PROPERTY_TYPES: { value: string; label: string }[] = [
  { value: "single_family", label: "Single family" },
  { value: "condo", label: "Condo" },
  { value: "townhouse", label: "Townhouse" },
  { value: "multi_family", label: "Multi-family" },
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
            "inline-flex h-8 items-center gap-1 rounded-full border px-3 text-xs font-medium transition-colors",
            active ? "border-primary bg-primary text-primary-foreground" : "bg-card text-foreground hover:border-foreground/30",
          )}
        >
          {active ?? label}
          <ChevronDown className="size-3.5 opacity-70" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className={width}>
        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
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
  const [form, setForm] = React.useState<FilterForm>(() => filtersToForm(initial));
  const [error, setError] = React.useState<string | null>(null);
  const { data: status } = useStatus();
  const initialKey = JSON.stringify(initial ?? null);
  const formRef = React.useRef(form);
  formRef.current = form;

  React.useEffect(() => {
    setForm(filtersToForm(initial));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKey]);

  const set = <K extends keyof FilterForm>(key: K, value: FilterForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const dirty = JSON.stringify(form) !== JSON.stringify(EMPTY_FORM);

  /** Validate and run the search with the given form (defaults to the current one). */
  const run = (next: FilterForm = formRef.current, quiet = false) => {
    const parsed = parseZips(next.location);
    if (parsed.error) return setError(parsed.error);
    if (!parsed.zip_codes.length) {
      if (!quiet) setError("Enter a 5-digit ZIP code — for example 38116.");
      return;
    }
    if (parsed.zip_codes.length > 1) {
      return setError("Search one ZIP code at a time.");
    }
    if (next.minPrice != null && next.maxPrice != null && next.minPrice > next.maxPrice) return setError("Minimum price is higher than maximum price.");
    if (next.minYear != null && next.maxYear != null && next.minYear > next.maxYear) return setError("“Built from” is later than “built to”.");
    setError(null);
    onSearch(formToFilters(next));
  };
  // Filter panels apply as soon as there is a ZIP code; without one they just remember the choice.
  const apply = (values?: Partial<FilterForm>) => {
    const next = values ? { ...formRef.current, ...values } : formRef.current;
    if (values) setForm(next);
    run(next, true);
  };

  const returnsCount = [form.minGrossYield, form.minCashFlow, form.minCashOnCash, form.minCapRate, form.minNetYield].filter((v) => v != null).length;
  const moreCount = [form.maxHoa, form.maxDom].filter((v) => v != null).length;
  const types = form.propertyTypes;

  return (
    <Card>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          run();
        }}
        aria-label="Property search"
        className="space-y-3 p-3 sm:p-4"
      >
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <MapPin className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              id="f-location"
              aria-label="ZIP code"
              placeholder="ZIP code — e.g. 38116"
              inputMode="numeric"
              maxLength={5}
              value={form.location}
              onChange={(e) => set("location", e.target.value)}
              autoComplete="postal-code"
              className="h-11 pl-9 text-[15px]"
            />
          </div>
          <Button type="submit" size="lg" disabled={busy} className="h-11 px-5">
            <Search /> <span className="hidden sm:inline">{busy ? "Searching…" : "Search"}</span>
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
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
                <label key={value} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted">
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
            <p className="text-[11px] text-muted-foreground">Homes with no recorded build year are hidden while this filter is on.</p>
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
              <Field label="Min cash-on-cash" htmlFor="f-coc">
                <NumberInput id="f-coc" suffix="%" placeholder="Any" value={form.minCashOnCash} onValueChange={(v) => set("minCashOnCash", v)} />
              </Field>
              <Field label="Min cap rate" htmlFor="f-cap">
                <NumberInput id="f-cap" suffix="%" placeholder="Any" value={form.minCapRate} onValueChange={(v) => set("minCapRate", v)} />
              </Field>
              <Field label="Min net yield" htmlFor="f-net">
                <NumberInput id="f-net" suffix="%" placeholder="Any" value={form.minNetYield} onValueChange={(v) => set("minNetYield", v)} />
              </Field>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">Calculated with 25% down at 7% (default financing) as a long-term rental.</p>
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
              className="inline-flex h-8 items-center gap-1 rounded-full px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
              onClick={() => {
                setForm({ ...EMPTY_FORM });
                setError(null);
                onReset();
              }}
            >
              <X className="size-3.5" aria-hidden /> Clear all
            </button>
          ) : null}

          {status?.data_mode === "demo" ? (
            <span className="ml-auto hidden text-[11px] text-muted-foreground lg:inline">
              Demo ZIPs: {status.demo_markets.slice(0, 4).map((m) => `${m.zip_codes.split(",")[0]} ${m.city}`).join(" · ")}
            </span>
          ) : null}
        </div>

        {error ? <Alert tone="error">{error}</Alert> : null}
      </form>
    </Card>
  );
}
