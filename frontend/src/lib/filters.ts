import type { SearchFilters, SortKey, StrategyFilter } from "./types";

/** Editable form state for the search panel (text fields stay free-form while typing). */
export interface FilterForm {
  /** One free-text location: "Memphis, TN", "38116, 38118", "TN", or several separated by ";". */
  location: string;
  county: string;
  radius: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  minGrossYield: number | null;
  minNetYield: number | null;
  minCapRate: number | null;
  minCashOnCash: number | null;
  minCashFlow: number | null;
  minBeds: number | null;
  maxBeds: number | null;
  propertyTypes: string[];
  maxHoa: number | null;
  maxDom: number | null;
  minYear: number | null;
  maxYear: number | null;
  strategy: StrategyFilter;
  polygon: [number, number][] | null;
}

export const EMPTY_FORM: FilterForm = {
  location: "",
  county: "",
  radius: null,
  minPrice: null,
  maxPrice: null,
  minGrossYield: null,
  minNetYield: null,
  minCapRate: null,
  minCashOnCash: null,
  minCashFlow: null,
  minBeds: null,
  maxBeds: null,
  propertyTypes: [],
  maxHoa: null,
  maxDom: null,
  minYear: null,
  maxYear: null,
  strategy: "ltr",
  polygon: null,
};

export const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO",
  "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "score", label: "Best overall score" },
  { value: "gross_yield", label: "Highest gross rental yield" },
  { value: "net_yield", label: "Highest net rental yield" },
  { value: "cap_rate", label: "Highest cap rate" },
  { value: "cash_on_cash", label: "Highest cash on cash return" },
  { value: "cash_flow", label: "Highest monthly cash flow" },
  { value: "upfront", label: "Lowest upfront investment" },
  { value: "dscr", label: "Highest DSCR" },
  { value: "ltr_return", label: "Best rental return" },
  { value: "price_asc", label: "Lowest price" },
  { value: "price_desc", label: "Highest price" },
  { value: "newest", label: "Newest listings" },
];

export interface ParsedLocation {
  zip_codes: string[];
  cities: string[];
  state: string | null;
  error: string | null;
}

/**
 * Parse the single location box. Accepts ZIP codes ("38116" or "38116, 38118"), a state
 * ("TN"), and cities with their state ("Memphis, TN" or "Memphis TN"); several entries can be
 * separated with ";".
 */
/** Searches are by ZIP code only (for now): accepts "38116" or "38116, 38118". */
export function parseZips(text: string): { zip_codes: string[]; error: string | null } {
  const tokens = text.split(/[\s,;]+/).filter(Boolean);
  const zips: string[] = [];
  for (const token of tokens) {
    if (!/^\d{5}$/.test(token)) {
      return { zip_codes: [], error: /^\d+$/.test(token) ? `“${token}” is not a 5-digit ZIP code.` : "Search by ZIP code — for example 38116. City and state searches are coming later." };
    }
    if (!zips.includes(token)) zips.push(token);
  }
  return { zip_codes: zips, error: null };
}

export function parseLocation(text: string): ParsedLocation {
  const out: ParsedLocation = { zip_codes: [], cities: [], state: null, error: null };
  for (const raw of text.split(/[;\n]+/)) {
    const part = raw.trim().replace(/\s+/g, " ");
    if (!part) continue;
    const tokens = part.split(/[\s,]+/).filter(Boolean);
    if (tokens.every((t) => /^\d+$/.test(t))) {
      const bad = tokens.find((t) => !/^\d{5}$/.test(t));
      if (bad) return { ...out, error: `“${bad}” is not a 5-digit ZIP code.` };
      for (const zip of tokens) if (!out.zip_codes.includes(zip)) out.zip_codes.push(zip);
      continue;
    }
    if (/^[A-Za-z]{2}$/.test(part) && US_STATES.includes(part.toUpperCase())) {
      out.state = part.toUpperCase();
      continue;
    }
    const match = part.match(/^([A-Za-z .'\-]+?)[,\s]+([A-Za-z]{2})$/);
    if (match && US_STATES.includes(match[2].toUpperCase())) {
      const city = match[1].trim().replace(/\b\w/g, (c) => c.toUpperCase());
      const label = `${city}, ${match[2].toUpperCase()}`;
      if (!out.cities.includes(label)) out.cities.push(label);
      continue;
    }
    return { ...out, error: `Add the state to “${part}” — for example “${part}, GA” — or enter a ZIP code.` };
  }
  return out;
}

export function formatLocation(filters: Partial<SearchFilters> | null | undefined): string {
  if (!filters) return "";
  const parts: string[] = [];
  if (filters.cities?.length) parts.push(...filters.cities);
  if (filters.zip_codes?.length) parts.push(filters.zip_codes.join(", "));
  if (filters.state && !filters.cities?.length) parts.push(filters.state);
  return parts.join("; ");
}

export function formToFilters(form: FilterForm): SearchFilters {
  const filters: SearchFilters = { strategy: form.strategy };
  const { zip_codes } = parseZips(form.location);
  if (zip_codes.length) filters.zip_codes = zip_codes;
  const numeric: [keyof SearchFilters, number | null][] = [
    ["min_price", form.minPrice],
    ["max_price", form.maxPrice],
    ["min_gross_yield", form.minGrossYield],
    ["min_net_yield", form.minNetYield],
    ["min_cap_rate", form.minCapRate],
    ["min_cash_on_cash", form.minCashOnCash],
    ["min_cash_flow", form.minCashFlow],
    ["min_beds", form.minBeds],
    ["max_beds", form.maxBeds],
    ["max_hoa", form.maxHoa],
    ["max_days_on_market", form.maxDom],
    ["min_year_built", form.minYear],
    ["max_year_built", form.maxYear],
  ];
  for (const [key, value] of numeric) {
    if (value !== null && value !== undefined) (filters as Record<string, unknown>)[key] = value;
  }
  if (form.propertyTypes.length) filters.property_types = form.propertyTypes as SearchFilters["property_types"];
  return filters;
}

const n = (value: unknown): number | null => (value === null || value === undefined || value === "" ? null : Number(value));

export function filtersToForm(filters: Partial<SearchFilters> | null | undefined): FilterForm {
  if (!filters) return { ...EMPTY_FORM };
  return {
    location: formatLocation(filters),
    county: filters.county ?? "",
    radius: n(filters.radius_miles),
    minPrice: n(filters.min_price),
    maxPrice: n(filters.max_price),
    minGrossYield: n(filters.min_gross_yield),
    minNetYield: n(filters.min_net_yield),
    minCapRate: n(filters.min_cap_rate),
    minCashOnCash: n(filters.min_cash_on_cash),
    minCashFlow: n(filters.min_cash_flow),
    minBeds: n(filters.min_beds),
    maxBeds: n(filters.max_beds),
    propertyTypes: (filters.property_types ?? []) as string[],
    maxHoa: n(filters.max_hoa),
    maxDom: n(filters.max_days_on_market),
    minYear: n(filters.min_year_built),
    maxYear: n(filters.max_year_built),
    strategy: "ltr" as StrategyFilter,
    polygon: (filters.polygon as [number, number][] | null | undefined) ?? null,
  };
}

export function hasLocation(filters: SearchFilters): boolean {
  return Boolean(filters.zip_codes?.length || filters.cities?.length || filters.state || filters.polygon?.length);
}

export function decodeFilters(raw: string | null): SearchFilters | null {
  if (!raw) return null;
  for (const candidate of [raw, safeDecode(raw)]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as SearchFilters;
    } catch {
      /* try the next representation */
    }
  }
  return null;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export function searchHref(filters: SearchFilters, extra: { sort?: string; view?: string; base?: string } = {}): string {
  const params = new URLSearchParams();
  params.set("f", JSON.stringify(filters));
  if (extra.sort) params.set("sort", extra.sort);
  if (extra.view) params.set("view", extra.view);
  return `${extra.base ?? "/"}?${params.toString()}`;
}

/** One-line human summary of a filter set (for saved searches and headings). */
export function describeFilters(filters: Partial<SearchFilters>): string {
  const parts: string[] = [];
  if (filters.cities?.length) parts.push(filters.cities.join("; "));
  if (filters.zip_codes?.length) parts.push(`ZIP ${filters.zip_codes.join(", ")}`);
  if (filters.county) parts.push(`${filters.county} County${filters.state ? `, ${filters.state}` : ""}`);
  else if (filters.state && !filters.cities?.length && !filters.zip_codes?.length) parts.push(filters.state);
  if (filters.polygon?.length && !parts.length) parts.push("Drawn map area");
  if (filters.radius_miles) parts.push(`within ${filters.radius_miles} mi`);
  const money = (v: unknown) => `$${Number(v).toLocaleString("en-US")}`;
  if (filters.min_price != null && filters.max_price != null) parts.push(`${money(filters.min_price)}–${money(filters.max_price)}`);
  else if (filters.max_price != null) parts.push(`≤ ${money(filters.max_price)}`);
  else if (filters.min_price != null) parts.push(`≥ ${money(filters.min_price)}`);
  if (filters.min_gross_yield != null) parts.push(`gross yield ≥ ${filters.min_gross_yield}%`);
  if (filters.min_net_yield != null) parts.push(`net yield ≥ ${filters.min_net_yield}%`);
  if (filters.min_cap_rate != null) parts.push(`cap rate ≥ ${filters.min_cap_rate}%`);
  if (filters.min_cash_on_cash != null) parts.push(`CoC ≥ ${filters.min_cash_on_cash}%`);
  if (filters.min_cash_flow != null) parts.push(`cash flow ≥ ${money(filters.min_cash_flow)}/mo`);
  if (filters.min_beds != null || filters.max_beds != null) parts.push(`${filters.min_beds ?? 0}–${filters.max_beds ?? "any"} beds`);
  if (filters.property_types?.length) parts.push(filters.property_types.map((t) => t.replace("_", " ")).join("/"));
  return parts.join(" · ") || "All properties";
}
