"use client";

import * as React from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "./api";
import type { AssumptionOverrides, AssumptionSection, PropertyCard, ScoreWeights, SessionOut, SystemStatus, User } from "./types";

// ----------------------------------------------------------------------------- local persistence

function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeLocal(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode): state simply lasts for the session */
  }
}

// ----------------------------------------------------------------------------- types

export interface CompareItem {
  id: string;
  address: string;
  price: number | null;
}

interface AppState {
  /** Standing assumptions applied to every analysis (financing, expense ratios, growth rates). */
  defaults: AssumptionOverrides;
  weights: ScoreWeights | null;
  setDefault: (section: AssumptionSection, field: string, value: number | null) => void;
  resetDefaults: () => void;
  setWeights: (weights: ScoreWeights | null) => void;
  /** null when nothing is customised, so API requests stay minimal and cache-friendly. */
  defaultsOrNull: AssumptionOverrides | null;
  compare: CompareItem[];
  toggleCompare: (card: Pick<PropertyCard, "id" | "formatted_address" | "price">) => void;
  removeCompare: (id: string) => void;
  clearCompare: () => void;
  isCompared: (id: string) => boolean;
  hydrated: boolean;
}

export const MAX_COMPARE = 5;
const AppContext = React.createContext<AppState | null>(null);

function prune(defaults: AssumptionOverrides): AssumptionOverrides {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [section, fields] of Object.entries(defaults ?? {})) {
    const kept = Object.fromEntries(Object.entries((fields ?? {}) as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined));
    if (Object.keys(kept).length) out[section] = kept;
  }
  return out as AssumptionOverrides;
}

function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [defaults, setDefaults] = React.useState<AssumptionOverrides>({});
  const [weights, setWeightsState] = React.useState<ScoreWeights | null>(null);
  const [compare, setCompare] = React.useState<CompareItem[]>([]);
  const [hydrated, setHydrated] = React.useState(false);
  const session = useSession();
  const userId = session.user?.id ?? null;
  const syncedFor = React.useRef<string | null>(null);

  React.useEffect(() => {
    setDefaults(readLocal<AssumptionOverrides>("py.defaults", {}));
    setWeightsState(readLocal<ScoreWeights | null>("py.weights", null));
    setCompare(readLocal<CompareItem[]>("py.compare", []));
    setHydrated(true);
  }, []);

  // Signed-in users: load saved preferences once per login.
  React.useEffect(() => {
    if (!userId || syncedFor.current === userId) return;
    syncedFor.current = userId;
    api
      .preferences()
      .then((prefs) => {
        if (prefs.default_assumptions && Object.keys(prefs.default_assumptions).length) {
          const next = prune(prefs.default_assumptions as AssumptionOverrides);
          setDefaults(next);
          writeLocal("py.defaults", next);
        }
        if (prefs.score_weights) {
          setWeightsState(prefs.score_weights);
          writeLocal("py.weights", prefs.score_weights);
        }
      })
      .catch(() => undefined);
  }, [userId]);

  const persist = React.useCallback(
    (nextDefaults: AssumptionOverrides, nextWeights: ScoreWeights | null) => {
      writeLocal("py.defaults", nextDefaults);
      writeLocal("py.weights", nextWeights);
      if (userId) {
        api.savePreferences({ default_assumptions: nextDefaults, score_weights: nextWeights }).catch(() => toast.error("Could not save your preferences to your account."));
      }
    },
    [userId],
  );

  const value = React.useMemo<AppState>(() => {
    const pruned = prune(defaults);
    return {
      defaults: pruned,
      weights,
      hydrated,
      defaultsOrNull: Object.keys(pruned).length ? pruned : null,
      setDefault: (section, field, fieldValue) => {
        const next = prune({ ...defaults, [section]: { ...((defaults[section] ?? {}) as object), [field]: fieldValue } } as AssumptionOverrides);
        setDefaults(next);
        persist(next, weights);
      },
      resetDefaults: () => {
        setDefaults({});
        setWeightsState(null);
        persist({}, null);
      },
      setWeights: (next) => {
        setWeightsState(next);
        persist(pruned, next);
      },
      compare,
      isCompared: (id) => compare.some((item) => item.id === id),
      toggleCompare: (card) => {
        setCompare((current) => {
          let next: CompareItem[];
          if (current.some((item) => item.id === card.id)) next = current.filter((item) => item.id !== card.id);
          else if (current.length >= MAX_COMPARE) {
            toast.warning(`You can compare up to ${MAX_COMPARE} properties. Remove one first.`);
            return current;
          } else next = [...current, { id: card.id, address: card.formatted_address, price: card.price ?? null }];
          writeLocal("py.compare", next);
          return next;
        });
      },
      removeCompare: (id) =>
        setCompare((current) => {
          const next = current.filter((item) => item.id !== id);
          writeLocal("py.compare", next);
          return next;
        }),
      clearCompare: () => {
        setCompare([]);
        writeLocal("py.compare", []);
      },
    };
  }, [defaults, weights, compare, hydrated, persist]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const ctx = React.useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside <Providers>");
  return ctx;
}

// ----------------------------------------------------------------------------- server state hooks

export function useStatus() {
  return useQuery<SystemStatus>({ queryKey: ["status"], queryFn: api.status, staleTime: 60_000 });
}

export function useSession(): { user: User | null; loading: boolean; refresh: () => Promise<void> } {
  const client = useQueryClient();
  const query = useQuery<SessionOut>({ queryKey: ["session"], queryFn: api.me, staleTime: 5 * 60_000, retry: false });
  return {
    user: query.data?.user ?? null,
    loading: query.isLoading,
    refresh: async () => {
      await client.invalidateQueries({ queryKey: ["session"] });
      await client.invalidateQueries({ queryKey: ["favorite-ids"] });
    },
  };
}

export function useFavoriteIds() {
  const { user } = useSession();
  const client = useQueryClient();
  const query = useQuery<string[]>({ queryKey: ["favorite-ids", user?.id], queryFn: api.favoriteIds, enabled: !!user, staleTime: 30_000 });
  const ids = React.useMemo(() => new Set(query.data ?? []), [query.data]);

  const toggle = React.useCallback(
    async (propertyId: string): Promise<boolean> => {
      if (!user) {
        toast.info("Sign in to save properties", { action: { label: "Sign in", onClick: () => (window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`) } });
        return false;
      }
      const saved = ids.has(propertyId);
      try {
        if (saved) await api.removeFavorite(propertyId);
        else await api.addFavorite(propertyId);
        await client.invalidateQueries({ queryKey: ["favorite-ids"] });
        await client.invalidateQueries({ queryKey: ["favorites"] });
        toast.success(saved ? "Removed from saved properties" : "Property saved");
        return true;
      } catch (error) {
        toast.error(error instanceof ApiError ? error.message : "Could not update saved properties");
        return false;
      }
    },
    [user, ids, client],
  );
  return { ids, toggle, signedIn: !!user };
}

// ----------------------------------------------------------------------------- root provider

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <AppStateProvider>{children}</AppStateProvider>
    </QueryClientProvider>
  );
}
