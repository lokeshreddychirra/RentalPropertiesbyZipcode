import type {
  Account,
  AdminUser,
  AdminUsers,
  PlanInfo,
  PlansInfo,
  AIExplanationResponse,
  AssumptionOverrides,
  CompareResponse,
  Favorite,
  FinancingPreset,
  MapResults,
  MarketSummary,
  Meta,
  NLParseResult,
  NotificationList,
  Preferences,
  PropertyAnalysis,
  PropertyDetail,
  ProviderUsage,
  Regulation,
  RentEstimate,
  SavedAnalysis,
  SavedSearch,
  ScoreWeights,
  SearchFilters,
  SearchJob,
  SearchResults,
  SessionOut,
  SortKey,
  StrEstimate,
  SystemStatus,
  UsageReport,
  ValueEstimate,
  Watchlist,
} from "./types";

const BASE = "/api/v1";

export class ApiError extends Error {
  status: number;
  code: string;
  details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Field-level validation messages, when the API provided them. */
  get fieldMessages(): string[] {
    const fields = this.details?.fields;
    if (!Array.isArray(fields)) return [];
    return fields.map((f: { field?: string; message?: string }) => [f.field, f.message?.replace(/^Value error, /, "")].filter(Boolean).join(": "));
  }
}

async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...rest,
      credentials: "same-origin",
      headers: { Accept: "application/json", ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiError(0, "network_error", "Could not reach the server. Check your connection and try again.");
  }
  if (response.status === 204) return undefined as T;
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    /* non-JSON body */
  }
  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)?.error;
    throw new ApiError(response.status, error?.code ?? "error", error?.message ?? `Request failed (${response.status})`, error?.details ?? {});
  }
  return payload as T;
}

function qs(params: Record<string, string | number | boolean | null | undefined | string[]>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) value.forEach((v) => search.append(key, v));
    else search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export interface AnalysisBody {
  property_id?: string | null;
  overrides?: AssumptionOverrides | null;
  defaults?: AssumptionOverrides | null;
  weights?: ScoreWeights | null;
  include?: ("forecast" | "scenarios" | "sensitivity" | "financing")[];
  custom_financing?: { name: string; down_payment_pct: number; interest_rate_pct: number; loan_term_years: number }[];
}

export const api = {
  // --- system
  status: () => request<SystemStatus>("/system/status"),
  meta: () => request<Meta>("/system/meta"),
  usage: () => request<UsageReport>("/system/usage"),
  updateBudget: (key: string, body: Record<string, unknown>) => request<ProviderUsage>(`/system/budgets/${key}`, { method: "PUT", json: body }),
  regulations: () => request<Regulation[]>("/system/str-regulations"),
  saveRegulation: (body: Record<string, unknown>) => request<Regulation>("/system/str-regulations", { method: "PUT", json: body }),
  deleteRegulation: (id: string) => request<void>(`/system/str-regulations/${id}`, { method: "DELETE" }),

  // --- auth
  me: () => request<SessionOut>("/auth/me"),
  login: (email: string, password: string) => request<SessionOut>("/auth/login", { method: "POST", json: { email, password } }),
  register: (email: string, password: string, name?: string) => request<SessionOut>("/auth/register", { method: "POST", json: { email, password, name: name || null } }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  preferences: () => request<Preferences>("/auth/preferences"),
  savePreferences: (body: Preferences) => request<Preferences>("/auth/preferences", { method: "PUT", json: body }),

  // --- account, plans and billing
  account: () => request<Account>("/account"),
  plans: () => request<PlansInfo>("/account/plans"),
  checkout: (plan: "pro" | "premium") => request<{ url: string }>("/billing/checkout", { method: "POST", json: { plan } }),
  billingPortal: () => request<{ url: string }>("/billing/portal", { method: "POST" }),
  adminUsers: (q?: string) => request<AdminUsers>(`/admin/users${qs({ q: q || undefined })}`),
  updateUser: (id: string, body: { plan?: string; role?: string; is_active?: boolean; reset_usage?: boolean }) => request<AdminUser>(`/admin/users/${id}`, { method: "PATCH", json: body }),
  adminPlans: () => request<PlanInfo[]>("/admin/plans"),
  updatePlan: (key: string, body: { price_usd: number; zip_searches: number | null; property_reports: number | null; zips_per_search: number }) =>
    request<PlanInfo>(`/admin/plans/${key}`, { method: "PUT", json: body }),

  // --- search
  runSearch: (filters: SearchFilters, defaults: AssumptionOverrides | null, weights: ScoreWeights | null, refresh = false) =>
    request<SearchJob>("/searches/run", { method: "POST", json: { filters, defaults, weights, refresh } }),
  job: (id: string) => request<SearchJob>(`/searches/jobs/${id}`),
  results: (id: string, params: { sort: SortKey; page: number; page_size: number; bbox?: string | null; polygon?: string | null }) =>
    request<SearchResults>(`/searches/jobs/${id}/results${qs(params)}`),
  mapPoints: (id: string) => request<MapResults>(`/searches/jobs/${id}/map`),
  parseQuery: (query: string) => request<NLParseResult>("/searches/parse", { method: "POST", json: { query } }),
  saveSearch: (body: Record<string, unknown>) => request<SavedSearch>("/searches/save", { method: "POST", json: body }),
  savedSearches: () => request<SavedSearch[]>("/searches/saved"),
  updateSavedSearch: (id: string, body: Record<string, unknown>) => request<SavedSearch>(`/searches/saved/${id}`, { method: "PATCH", json: body }),
  deleteSavedSearch: (id: string) => request<void>(`/searches/saved/${id}`, { method: "DELETE" }),

  // --- properties
  property: (id: string) => request<PropertyDetail>(`/properties/${id}`),
  rentEstimate: (id: string, fetch = false) => request<RentEstimate>(`/properties/${id}/rent-estimate${qs({ fetch })}`),
  valueEstimate: (id: string, fetch = false) => request<ValueEstimate>(`/properties/${id}/value-estimate${qs({ fetch })}`),
  strEstimate: (id: string, fetch = false) => request<StrEstimate>(`/properties/${id}/str-estimate${qs({ fetch })}`),
  taxRecord: (id: string) => request<{ available: boolean; reason?: string; annual_amount?: number; year?: number; source?: string }>(`/properties/${id}/tax-record`, { method: "POST" }),

  // --- analysis
  calculate: (body: AnalysisBody, signal?: AbortSignal) => request<PropertyAnalysis>("/analysis/calculate", { method: "POST", json: body, signal }),
  compare: (property_ids: string[], defaults: AssumptionOverrides | null, weights: ScoreWeights | null) =>
    request<CompareResponse>("/analysis/compare", { method: "POST", json: { property_ids, defaults, weights } }),
  aiExplanation: (body: AnalysisBody) => request<AIExplanationResponse>("/analysis/ai-explanation", { method: "POST", json: body }),
  saveAnalysis: (body: Record<string, unknown>) => request<SavedAnalysis>("/analysis/saved", { method: "POST", json: body }),
  savedAnalyses: () => request<SavedAnalysis[]>("/analysis/saved"),
  deleteSavedAnalysis: (id: string) => request<void>(`/analysis/saved/${id}`, { method: "DELETE" }),

  // --- market
  market: (params: { zip_codes?: string[]; city?: string; state?: string }) => request<MarketSummary>(`/market/summary${qs(params)}`),

  // --- saved
  favorites: (defaults: AssumptionOverrides | null, weights: ScoreWeights | null) => request<Favorite[]>("/favorites/query", { method: "POST", json: { defaults, weights } }),
  favoriteIds: () => request<string[]>("/favorites/ids"),
  addFavorite: (property_id: string, extra: { notes?: string | null; watchlist_id?: string | null } = {}) => request<Favorite>("/favorites", { method: "POST", json: { property_id, ...extra } }),
  updateFavorite: (property_id: string, body: { notes?: string | null; watchlist_id?: string | null }) => request<Favorite>(`/favorites/${property_id}`, { method: "PATCH", json: body }),
  removeFavorite: (property_id: string) => request<void>(`/favorites/${property_id}`, { method: "DELETE" }),
  watchlists: () => request<Watchlist[]>("/watchlists"),
  createWatchlist: (name: string) => request<Watchlist>("/watchlists", { method: "POST", json: { name } }),
  deleteWatchlist: (id: string) => request<void>(`/watchlists/${id}`, { method: "DELETE" }),
  financingPresets: () => request<FinancingPreset[]>("/financing-scenarios"),
  createFinancingPreset: (body: Record<string, unknown>) => request<FinancingPreset>("/financing-scenarios", { method: "POST", json: body }),
  deleteFinancingPreset: (id: string) => request<void>(`/financing-scenarios/${id}`, { method: "DELETE" }),
  notifications: () => request<NotificationList>("/notifications"),
  markAllRead: () => request<void>("/notifications/read-all", { method: "POST" }),
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const fields = error.fieldMessages;
    return fields.length ? fields.join(" · ") : error.message;
  }
  return "Something went wrong. Please try again.";
}
