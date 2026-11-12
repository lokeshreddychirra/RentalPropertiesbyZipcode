"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, BookmarkPlus, ChevronLeft, ChevronRight, GitCompareArrows, Info, LayoutGrid, Lock, Map as MapIcon, RefreshCw, SearchX, Sparkles, Table2, X } from "@/components/ui/icons";
import { toast } from "sonner";
import { MapView } from "@/components/map/map-view";
import { ConfidenceBadge, DemoTag, ScoreRing } from "@/components/property/bits";
import { Button } from "@/components/ui/button";
import { Alert, Card, EmptyState, Skeleton, Table, Td, Th } from "@/components/ui/card";
import { Field, Input, Select, Switch } from "@/components/ui/form";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/overlays";
import { api, ApiError, errorMessage } from "@/lib/api";
import { decodeFilters, describeFilters, SORT_OPTIONS } from "@/lib/filters";
import { MAX_COMPARE, useApp, useSession } from "@/lib/store";
import type { PropertyCard as CardData, SearchFilters, SearchJob, SortKey, StrategyFilter } from "@/lib/types";
import { cn, pct, ratio, relativeTime, signTone, usd } from "@/lib/utils";
import { PropertyCard, viewOf } from "./property-card";
import { SearchPanel } from "./search-panel";

type View = "list" | "map" | "table";
const VIEWS: { value: View; label: string; hint: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { value: "list", label: "List", hint: "Property cards, best first", icon: LayoutGrid },
  { value: "map", label: "Map", hint: "Map beside the list; markers show price and yield", icon: MapIcon },
  { value: "table", label: "Table", hint: "Every metric side by side", icon: Table2 },
];
/** Older links used "split" (map + list); that is now simply the map view. */
const toView = (value: string | null, fallback: View): View => (value === "split" ? "map" : value === "list" || value === "map" || value === "table" ? value : fallback);
const PAGE_SIZE = 24;
/** Newer results replace the ones on screen automatically only this soon after the first appear. */
const AUTO_UPDATE_MS = 2500;

// ----------------------------------------------------------------------------- pieces

function Progress({ job }: { job: SearchJob | undefined }) {
  const progress = job?.progress;
  const percent = progress?.percent ?? 2;
  return (
    <Card className="p-6" role="status" aria-live="polite">
      <div className="mb-2 flex items-center justify-between gap-3 text-sm">
        <span className="title-4">{progress?.message ?? "Starting search…"}</span>
        <span className="tnum text-muted-foreground">{percent}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Search progress">
        <div className="h-full origin-left rounded-full bg-primary transition-transform duration-500" style={{ transform: `scaleX(${Math.max(percent, 3) / 100})` }} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Listings in your ZIP code are screened against your filters, then every match is analysed for rent, cash flow and yield.
      </p>
    </Card>
  );
}

/** Shown above results that are still growing (large ZIP codes) or being refreshed in the background. */
function LiveStatus({ job, loadingMore, update, fresh, onUpdate }: { job: SearchJob; loadingMore: boolean; update: string | null; fresh: boolean; onUpdate: () => void }) {
  if (!loadingMore && !job.refreshing && !update) return null;
  return (
    <div className="glass flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl px-4 py-3" role="status" aria-live="polite" data-testid="live-status">
      {loadingMore || job.refreshing ? (
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <RefreshCw className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden />
          <p className="min-w-0 text-sm">
            {loadingMore ? (
              <>
                <span className="font-medium">Analysing more homes</span>
                <span className="text-muted-foreground">
                  {" · "}
                  {(job.progress?.listings_found ?? 0).toLocaleString()} found so far. The ranking may change as the rest load.
                </span>
              </>
            ) : (
              <>
                <span className="font-medium">Checking for new listings</span>
                <span className="text-muted-foreground">
                  {" · "}
                  These results use listings from {relativeTime(job.data_as_of)}. Fresh ones are loading in the background.
                </span>
              </>
            )}
          </p>
        </div>
      ) : (
        <p className="min-w-0 flex-1 text-sm">
          {fresh ? (
            <span className="font-medium">Fresh listings are ready</span>
          ) : (
            <>
              <span className="font-medium">Finished</span>
              <span className="text-muted-foreground">
                {" · "}All {(job.result_count ?? 0).toLocaleString()} matching homes analysed.
              </span>
            </>
          )}
        </p>
      )}
      {update ? (
        <Button size="sm" onClick={onUpdate} data-testid="show-update">
          <ArrowUp /> {update}
        </Button>
      ) : null}
    </div>
  );
}

function CardSkeletons({ count = 6 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i} className="overflow-hidden">
          <Skeleton className="aspect-[16/9] w-full rounded-none" />
          <div className="space-y-3 p-4">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </Card>
      ))}
    </div>
  );
}

/** Shown instead of results when a guest runs a search: searching needs a (free) account. */
function SignUpGate() {
  const next = typeof window !== "undefined" ? window.location.pathname + window.location.search : "/";
  return (
    <Card className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Lock className="size-5" aria-hidden />
      </span>
      <div>
        <h2 className="heading-6 text-balance">Create a free account to see results</h2>
        <p className="mx-auto mt-2 max-w-md text-pretty text-sm text-muted-foreground">
          Your first ZIP code search is free, with every listing analysed for cash flow, yield and risk. No card required.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button asChild>
          <Link href={`/login?mode=register&next=${encodeURIComponent(next)}`}>Create free account</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href={`/login?next=${encodeURIComponent(next)}`}>Sign in</Link>
        </Button>
      </div>
    </Card>
  );
}

/** Shown when the plan's allowance is used up (HTTP 402 from the API). */
function UpgradeCard({ message }: { message: string }) {
  return (
    <Card className="flex flex-col items-center gap-3 border-primary/30 px-6 py-10 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground">
        <Sparkles className="size-5" aria-hidden />
      </span>
      <div>
        <h2 className="heading-6 text-balance">Upgrade to keep searching</h2>
        <p className="mx-auto mt-2 max-w-md text-pretty text-sm text-muted-foreground">{message}</p>
      </div>
      <Button asChild>
        <Link href="/pricing">See plans</Link>
      </Button>
    </Card>
  );
}

function JobNotices({ job }: { job: SearchJob }) {
  return (
    <div className="space-y-2">
      {job.partial ? (
        <Alert tone="warning" title="These results are partial">
          <ul className="list-disc space-y-0.5 pl-4">
            {job.partial_reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {job.warnings.length ? (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {job.warnings.map((warning) => (
            <li key={warning} className="flex items-start gap-2">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>{warning}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ResultsTable({ cards, strategy }: { cards: CardData[]; strategy: StrategyFilter }) {
  const { toggleCompare, isCompared } = useApp();
  return (
    <Card className="overflow-hidden">
      <Table>
        <thead>
          <tr>
            <Th className="w-10">
              <span className="sr-only">Compare</span>
            </Th>
            <Th>Property</Th>
            <Th className="text-right">Score</Th>
            <Th className="text-right">Price</Th>
            <Th className="text-right">Rent / mo</Th>
            <Th className="text-right">Gross yield</Th>
            <Th className="text-right">Cap rate</Th>
            <Th className="text-right">Cash flow / mo</Th>
            <Th className="text-right">Cash-on-cash</Th>
            <Th className="text-right">DSCR</Th>
            <Th className="text-right">Upfront cash</Th>
            <Th>Confidence</Th>
          </tr>
        </thead>
        <tbody>
          {cards.map((card) => {
            const { summary } = viewOf(card, strategy);
            const ok = !!summary?.available;
            return (
              <tr key={card.id} className="hover:bg-muted/40">
                <Td>
                  <input type="checkbox" className="size-4 accent-[hsl(var(--primary))]" checked={isCompared(card.id)} onChange={() => toggleCompare(card)} aria-label={`Compare ${card.formatted_address}`} />
                </Td>
                <Td className="max-w-[260px]">
                  <Link href={`/properties/${card.id}`} className="block truncate font-medium hover:underline">
                    {card.address_line1 ?? card.formatted_address}
                  </Link>
                  <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                    {card.city}, {card.state} · {card.bedrooms ?? "—"} bd / {card.bathrooms ?? "—"} ba {card.is_demo ? <DemoTag /> : null}
                  </span>
                </Td>
                <Td className="text-right">
                  <div className="flex justify-end">
                    <ScoreRing score={card.score ?? summary?.score ?? null} size={34} />
                  </div>
                </Td>
                <Td className="tnum text-right font-medium">{usd(card.price)}</Td>
                <Td className="tnum text-right">{ok ? usd(summary?.monthly_income) : "—"}</Td>
                <Td className="tnum text-right">{ok ? pct(summary?.gross_yield_pct) : "—"}</Td>
                <Td className="tnum text-right">{ok ? pct(summary?.cap_rate_pct) : "—"}</Td>
                <Td className={cn("tnum text-right font-medium", ok && signTone(summary?.monthly_cash_flow))}>{ok ? usd(summary?.monthly_cash_flow) : "—"}</Td>
                <Td className={cn("tnum text-right", ok && signTone(summary?.cash_on_cash_pct))}>{ok ? pct(summary?.cash_on_cash_pct) : "—"}</Td>
                <Td className="tnum text-right">{ok ? (summary?.dscr != null ? ratio(summary.dscr) : "N/A") : "—"}</Td>
                <Td className="tnum text-right">{ok ? usd(summary?.total_cash_invested) : usd(card.upfront_cash)}</Td>
                <Td>
                  <ConfidenceBadge level={card.confidence} short />
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}

function SaveSearchDialog({ filters }: { filters: SearchFilters }) {
  const { user } = useSession();
  const { defaultsOrNull } = useApp();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [alerts, setAlerts] = React.useState(true);
  const [cashFlow, setCashFlow] = React.useState("");
  const [grossYield, setGrossYield] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) setName(describeFilters(filters).slice(0, 110));
  }, [open, filters]);

  if (!user) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="h-9">
          <BookmarkPlus /> Save search
        </Button>
      </DialogTrigger>
      <DialogContent title="Save this search" description="Re-run it any time from Saved Properties, and optionally get alerts.">
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            try {
              await api.saveSearch({
                name: name.trim() || "Saved search",
                filters,
                defaults: defaultsOrNull,
                alerts_enabled: alerts,
                cash_flow_threshold: cashFlow ? Number(cashFlow) : null,
                gross_yield_threshold: grossYield ? Number(grossYield) : null,
              });
              toast.success("Search saved");
              setOpen(false);
            } catch (error) {
              toast.error(errorMessage(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Name" htmlFor="ss-name">
            <Input id="ss-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
          </Field>
          <label className="flex items-start justify-between gap-3 rounded-lg border p-3">
            <span>
              <span className="block text-sm font-medium">Alerts</span>
              <span className="block text-xs text-muted-foreground">Notify me about new qualifying listings and price reductions. Checks run in the background and never repeat an alert.</span>
            </span>
            <Switch checked={alerts} onCheckedChange={setAlerts} aria-label="Enable alerts" />
          </label>
          {alerts ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Alert when cash flow ≥" htmlFor="ss-cf" hint="$ per month (optional)">
                <Input id="ss-cf" inputMode="decimal" value={cashFlow} onChange={(e) => setCashFlow(e.target.value.replace(/[^0-9.\-]/g, ""))} placeholder="e.g. 300" />
              </Field>
              <Field label="Alert when gross yield ≥" htmlFor="ss-gy" hint="% (optional)">
                <Input id="ss-gy" inputMode="decimal" value={grossYield} onChange={(e) => setGrossYield(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="e.g. 9" />
              </Field>
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save search"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CompareTray() {
  const { compare, removeCompare, clearCompare } = useApp();
  if (!compare.length) return null;
  return (
    <div className="fixed inset-x-0 bottom-[var(--tabbar-space)] z-40 border-t bg-card/95 shadow-[0_-4px_16px_rgb(16_24_40/0.08)] backdrop-blur" role="region" aria-label="Properties selected for comparison">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-2 px-4 py-3 lg:pl-64">
        <span className="text-sm font-medium">
          Compare <span className="tnum text-muted-foreground">({compare.length}/{MAX_COMPARE})</span>
        </span>
        <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto">
          {compare.map((item) => (
            <span key={item.id} className="inline-flex shrink-0 items-center gap-1 rounded-full border bg-background py-0.5 pl-3 pr-1 text-xs">
              <span className="max-w-[150px] truncate">{item.address.split(",")[0]}</span>
              <button type="button" className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => removeCompare(item.id)} aria-label={`Remove ${item.address} from comparison`}>
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
        <Button variant="ghost" size="sm" onClick={clearCompare}>
          Clear
        </Button>
        <Button asChild size="sm" disabled={compare.length < 2}>
          <Link href="/compare" aria-disabled={compare.length < 2}>
            <GitCompareArrows /> Compare properties
          </Link>
        </Button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------- main

interface Props {
  basePath: string;
  defaultView?: View;
  /** Page heading; a function receives whether a search is active (to show a compact version). */
  heading?: React.ReactNode | ((active: boolean) => React.ReactNode);
  /** Rendered above results when no search has been run yet. */
  idle?: React.ReactNode;
  /** Shown beside the heading and search box (large screens) before any search is run. */
}

export function SearchExperience({ basePath, defaultView = "list", heading, idle }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { defaultsOrNull, weights, hydrated } = useApp();
  const { user, loading: sessionLoading } = useSession();
  const isAdmin = user?.role === "admin";
  const queryClient = useQueryClient();

  const rawFilters = params.get("f");
  const filters = React.useMemo(() => decodeFilters(rawFilters), [rawFilters]);
  const sort = (params.get("sort") as SortKey) || "score";
  const view = toView(params.get("view"), defaultView);
  const page = Math.max(1, Number(params.get("page") ?? "1") || 1);
  const strategy: StrategyFilter = (filters?.strategy as StrategyFilter) ?? "both";

  const [refreshToken, setRefreshToken] = React.useState(0);
  const [bbox, setBbox] = React.useState<string | null>(null);
  const [followMap, setFollowMap] = React.useState(false);
  const [area, setArea] = React.useState<[number, number][] | null>(null);
  const [hovered, setHovered] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);

  const navigate = React.useCallback(
    (next: { filters?: SearchFilters | null; sort?: string | null; view?: string | null; page?: number | null }, replace = false) => {
      const search = new URLSearchParams(params.toString());
      if (next.filters !== undefined) {
        if (next.filters) search.set("f", JSON.stringify(next.filters));
        else search.delete("f");
        search.delete("page");
      }
      if (next.sort !== undefined) {
        if (next.sort && next.sort !== "score") search.set("sort", next.sort);
        else search.delete("sort");
        search.delete("page");
      }
      if (next.view !== undefined) {
        if (next.view && next.view !== defaultView) search.set("view", next.view);
        else search.delete("view");
      }
      if (next.page !== undefined) {
        if (next.page && next.page > 1) search.set("page", String(next.page));
        else search.delete("page");
      }
      const url = `${pathname === basePath ? pathname : basePath}${search.toString() ? `?${search}` : ""}`;
      if (replace) router.replace(url, { scroll: false });
      else router.push(url, { scroll: false });
    },
    [params, pathname, basePath, router, defaultView],
  );

  // Reset map-scoped filters when the search itself changes.
  React.useEffect(() => {
    setBbox(null);
    setArea(null);
    setSelected(null);
  }, [rawFilters]);

  const requestKey = React.useMemo(() => JSON.stringify([filters, defaultsOrNull, weights, refreshToken]), [filters, defaultsOrNull, weights, refreshToken]);

  const start = useQuery({
    queryKey: ["search-start", requestKey],
    queryFn: async () => {
      const job = await api.runSearch(filters as SearchFilters, defaultsOrNull, weights, refreshToken > 0);
      void queryClient.invalidateQueries({ queryKey: ["account"] });
      return job;
    },
    enabled: !!filters && hydrated && !!user,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: false,
  });
  const jobId = start.data?.id;

  const jobQuery = useQuery({
    queryKey: ["search-job", jobId],
    queryFn: () => api.job(jobId as string),
    enabled: !!jobId,
    initialData: start.data,
    // Poll quickly while the search runs, slower while fresh listings load in the background.
    refetchInterval: (query) => {
      const current = query.state.data;
      if (!current || !["completed", "failed"].includes(current.status)) return 600;
      return current.status === "completed" && current.refreshing ? 1500 : false;
    },
    retry: false,
  });
  const job = jobQuery.data;
  const finished = job?.status === "completed";
  // Results can be read as soon as the job has published some, even while later pages still load.
  const latestVersion = job && job.status !== "failed" ? job.results_version || (finished ? 1 : 0) : 0;
  const ready = latestVersion > 0;
  const loadingMore = ready && !finished;

  // The version on screen. Newer versions replace it automatically only when that would not move the
  // cards someone is reading; otherwise an "update" button offers them.
  const [shown, setShown] = React.useState<{ job: string; version: number; at: number } | null>(null);
  const shownVersion = shown && shown.job === jobId ? shown.version : 0;
  // The version current when the search finished: anything newer comes from the background refresh.
  const [finishedVersion, setFinishedVersion] = React.useState<{ job: string; version: number } | null>(null);
  React.useEffect(() => {
    if (finished && jobId && finishedVersion?.job !== jobId) setFinishedVersion({ job: jobId, version: latestVersion });
  }, [finished, jobId, latestVersion, finishedVersion]);
  React.useEffect(() => {
    if (jobId && latestVersion > 0 && shownVersion === 0) setShown({ job: jobId, version: latestVersion, at: Date.now() });
  }, [jobId, latestVersion, shownVersion]);

  const polygonParam = area?.length ? area.map(([lng, lat]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join(";") : null;
  const activeBbox = followMap && view === "map" ? bbox : null;

  const resultsFor = (version: number) => ({
    queryKey: ["search-results", jobId, version, sort, page, activeBbox, polygonParam],
    queryFn: () => api.results(jobId as string, { sort, page, page_size: PAGE_SIZE, bbox: activeBbox, polygon: polygonParam }),
    retry: false,
    staleTime: Infinity,
  });
  const results = useQuery({ ...resultsFor(shownVersion), enabled: !!jobId && shownVersion > 0, placeholderData: keepPreviousData });
  const latest = useQuery({ ...resultsFor(latestVersion), enabled: !!jobId && shownVersion > 0 && latestVersion > shownVersion });
  const mapQuery = useQuery({
    queryKey: ["search-map", jobId, shownVersion],
    queryFn: () => api.mapPoints(jobId as string),
    enabled: !!jobId && shownVersion > 0 && view === "map",
    staleTime: Infinity,
    placeholderData: keepPreviousData,
    retry: false,
  });

  // Compare the newer results with the cards on screen.
  const shownIds = results.data?.items.map((item) => item.id) ?? [];
  const latestIds = latest.data?.items.map((item) => item.id) ?? null;
  const newcomers = latestIds ? latestIds.filter((id) => !shownIds.includes(id)).length : 0;
  const unchanged = !!latestIds && results.data?.page === latest.data?.page && latestIds.join() === shownIds.join();
  const pendingUpdate = latestVersion > shownVersion && shownVersion > 0 && !!latest.data && !unchanged;
  const showLatest = React.useCallback(() => {
    if (jobId) setShown((prev) => ({ job: jobId, version: latestVersion, at: prev?.job === jobId ? prev.at : Date.now() }));
  }, [jobId, latestVersion]);
  React.useEffect(() => {
    if (!latest.data || latestVersion <= shownVersion || !shown) return;
    if (unchanged || Date.now() - shown.at < AUTO_UPDATE_MS) showLatest();
  }, [latest.data, latestVersion, shownVersion, shown, unchanged, showLatest]);
  const refreshedUpdate = !!finishedVersion && finishedVersion.job === jobId && latestVersion > finishedVersion.version;
  const updateLabel = !pendingUpdate
    ? null
    : refreshedUpdate
      ? "Show fresh listings"
      : newcomers > 0
        ? sort === "score"
          ? `${newcomers} better ${newcomers === 1 ? "match" : "matches"} found · show updated ranking`
          : `${newcomers} new ${newcomers === 1 ? "home" : "homes"} found · show`
        : "Show updated ranking";

  // Cached results expire server-side; transparently re-run when that happens.
  const expired = (results.error instanceof ApiError && results.error.status === 404) || (jobQuery.error instanceof ApiError && jobQuery.error.status === 404);
  React.useEffect(() => {
    if (expired) setRefreshToken((token) => token + 1);
  }, [expired]);

  const running = !!filters && !!user && (start.isLoading || (!!job && !["completed", "failed"].includes(job.status)));
  const waiting = running && !ready; // nothing to show yet
  const planLimit = start.error instanceof ApiError && start.error.status === 402 ? start.error.message : null;
  const needsAccount = !!filters && !sessionLoading && !user;
  const data = results.data;
  const cards = data?.items ?? [];
  const startError = start.error && !(start.error instanceof ApiError && start.error.status === 402) ? errorMessage(start.error) : null;

  const pager =
    data && data.total_pages > 1 ? (
      <nav className="flex items-center justify-center gap-2" aria-label="Results pages">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => navigate({ page: page - 1 })}>
          <ChevronLeft /> Previous
        </Button>
        <span className="tnum text-sm text-muted-foreground">
          Page {data.page} of {data.total_pages}
        </span>
        <Button variant="outline" size="sm" disabled={page >= data.total_pages} onClick={() => navigate({ page: page + 1 })}>
          Next <ChevronRight />
        </Button>
      </nav>
    ) : null;

  const list = (columns: string) =>
    results.isLoading ? (
      <CardSkeletons />
    ) : (
      <div className={cn("grid gap-4", columns, results.isFetching && "opacity-60 transition-opacity")}>
        {cards.map((card) => (
          <PropertyCard key={card.id} card={card} strategy={strategy} selected={selected === card.id} onHover={view === "map" ? setHovered : undefined} />
        ))}
      </div>
    );

  const map = (className: string) => (
    <MapView
      className={className}
      points={mapQuery.data?.points ?? []}
      selectedId={selected}
      hoveredId={hovered}
      onSelect={setSelected}
      onBoundsChange={(bounds) => setBbox(bounds.map((v) => v.toFixed(5)).join(","))}
      polygon={area}
      onPolygonChange={(polygon) => {
        setArea(polygon);
        navigate({ page: 1 }, true);
      }}
      allowDraw
    />
  );

  const headingNode = typeof heading === "function" ? heading(!!filters) : heading;
  const panel = (
    <SearchPanel
      initial={filters}
      busy={running}
      onSearch={(next) => navigate({ filters: next })}
      onReset={() => navigate({ filters: null, sort: null, page: null })}
    />
  );

  return (
    <div className="mx-auto max-w-[1440px] space-y-6 px-4 pb-24 pt-2 lg:px-6">
      {headingNode}
      {panel}

      {!filters ? idle : null}
      {needsAccount ? <SignUpGate /> : null}
      {planLimit ? <UpgradeCard message={planLimit} /> : null}
      {startError ? (
        <Alert tone="error" title="The search could not be started">
          {startError}
        </Alert>
      ) : null}
      {waiting ? (
        <>
          <Progress job={job} />
          <CardSkeletons count={3} />
        </>
      ) : null}
      {job?.status === "failed" ? (
        <Alert tone="error" title="Search failed">
          {job.error ?? "The search could not be completed."}{" "}
          <button type="button" className="font-medium underline" onClick={() => setRefreshToken((t) => t + 1)}>
            Try again
          </button>
        </Alert>
      ) : null}

      {ready && job ? (
        <section aria-label="Search results" className="space-y-4">
          {finished ? <JobNotices job={job} /> : null}
          <LiveStatus job={job} loadingMore={loadingMore} update={updateLabel} fresh={refreshedUpdate} onUpdate={showLatest} />

          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="heading-5" data-testid="result-count">
                {data ? `${data.total.toLocaleString()} ${data.total === 1 ? "property" : "properties"}${loadingMore || (pendingUpdate && !refreshedUpdate) ? " so far" : ""}` : "Loading results…"}
              </h2>
              <p className="caption-5 text-muted-foreground">
                Ranked by calculated returns
                {finished && !job.refreshing && latestVersion === shownVersion && job.data_as_of && job.data_mode !== "demo" ? ` · listings as of ${relativeTime(job.data_as_of)}` : ""}
                {isAdmin ? (
                  <>
                    {" · Admin: "}
                    {data ? `${data.summary.total.toLocaleString()} of ` : ""}
                    {(finished ? (job.listings_fetched ?? 0) : (job.progress?.listings_found ?? 0)).toLocaleString()} listings matched
                    {" · "}
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground"
                      onClick={() => setRefreshToken((t) => t + 1)}
                      title="Re-fetch listings from the provider (uses paid API requests)"
                    >
                      <RefreshCw className="size-3" aria-hidden /> Refresh data
                    </button>
                  </>
                ) : null}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {filters ? <SaveSearchDialog filters={filters} /> : null}
              <div className="w-56">
                <Select aria-label="Sort results" value={sort} onChange={(e) => navigate({ sort: e.target.value })}>
                  {SORT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="inline-flex rounded-xl border bg-muted p-1" role="tablist" aria-label="Result view" data-testid="view-switch">
                {VIEWS.map(({ value, label, hint, icon: Icon }) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    title={hint}
                    aria-selected={view === value}
                    onClick={() => navigate({ view: value }, true)}
                    className={cn(
                      "button-sm inline-flex h-8 items-center gap-2 rounded-lg px-3 transition-[color,background-color,box-shadow,transform] active:scale-[0.98]",
                      view === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon className="size-4" aria-hidden />
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {data && data.total > 0 ? (
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {[
                ["Median price", usd(data.summary.median_price)],
                ["Median gross yield", pct(data.summary.median_gross_yield_pct)],
                ["Median cap rate", pct(data.summary.median_cap_rate_pct)],
                ["Median cash flow", `${usd(data.summary.median_cash_flow)}/mo`],
                ["Positive cash flow", `${data.summary.positive_cash_flow_count} of ${data.total}`],
                ["Average score", data.summary.average_score != null ? data.summary.average_score.toFixed(0) : "—"],
              ].map(([label, value]) => (
                <div key={label} className="glass rounded-xl px-4 py-3">
                  <dt className="caption-5 text-muted-foreground">{label}</dt>
                  <dd className="tnum title-2 mt-1">{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          {view === "map" && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <label className="inline-flex items-center gap-2">
                <Switch checked={followMap} onCheckedChange={setFollowMap} aria-label="Only show properties in the visible map area" />
                Only list properties in the visible map area
              </label>
              {area?.length ? <span>Filtered to your drawn area ({area.length} points).</span> : <span>Draw an area on the map to filter results to it.</span>}
            </div>
          )}

          {results.error && !expired ? <Alert tone="error">{errorMessage(results.error)}</Alert> : null}

          {data && data.total === 0 ? (
            <EmptyState icon={<SearchX />} title="No properties match these filters">
              {data.summary.total > 0
                ? `None of the matching homes meet your return thresholds${activeBbox || polygonParam ? " inside the selected map area" : ""}. Try lowering the yield, cap rate or cash flow minimums.`
                : job.data_mode === "demo"
                  ? "The demo dataset only covers a set of sample markets (listed under the search panel). Try Atlanta, GA or ZIP 30269."
                  : (job.listings_fetched ?? 0) > 0
                    ? "There are homes for sale in this ZIP code, but none match your filters. The note above shows which filter to widen."
                    : "No active listings were found in this ZIP code right now."}
            </EmptyState>
          ) : null}

          {view === "list" ? list("sm:grid-cols-2 xl:grid-cols-3") : null}
          {view === "table" ? results.isLoading ? <Skeleton className="h-96 w-full" /> : cards.length ? <ResultsTable cards={cards} strategy={strategy} /> : null : null}
          {view === "map" ? (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]" data-testid="map-view">
              <div className="order-2 lg:order-1">{list("sm:grid-cols-2 lg:grid-cols-1 2xl:grid-cols-2")}</div>
              <div className="order-1 lg:order-2">
                <div className="lg:sticky lg:top-24">{map("h-[46vh] min-h-[320px] lg:h-[calc(100vh-8rem)]")}</div>
              </div>
            </div>
          ) : null}

          {pager}
        </section>
      ) : null}
      <CompareTray />
    </div>
  );
}
