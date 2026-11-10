"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, Bookmark, FolderPlus, History, Play, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PropertyCard } from "@/components/search/property-card";
import { CompareTray } from "@/components/search/search-experience";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Skeleton, Table, Td, Th } from "@/components/ui/card";
import { Input, Select, Switch, Textarea } from "@/components/ui/form";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/overlays";
import { api, errorMessage } from "@/lib/api";
import { describeFilters, searchHref } from "@/lib/filters";
import { useApp, useSession } from "@/lib/store";
import type { Favorite, SearchFilters, Watchlist } from "@/lib/types";
import { pct, relativeTime, shortDate, usd } from "@/lib/utils";

function FavoriteItem({ favorite, watchlists }: { favorite: Favorite; watchlists: Watchlist[] }) {
  const client = useQueryClient();
  const [notes, setNotes] = React.useState(favorite.notes ?? "");
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ["favorites"] }), client.invalidateQueries({ queryKey: ["watchlists"] })]);
  if (!favorite.card) {
    return (
      <Card className="p-4 text-sm text-muted-foreground">
        This saved property no longer has listing data.{" "}
        <button type="button" className="underline" onClick={async () => { await api.removeFavorite(favorite.property_id); await refresh(); }}>
          Remove
        </button>
      </Card>
    );
  }
  return (
    <div className="space-y-2">
      <PropertyCard card={favorite.card} strategy="both" />
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <Textarea
          aria-label="Notes"
          placeholder="Notes — e.g. roof age, agent call, offer strategy"
          value={notes}
          maxLength={2000}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={async () => {
            if (notes !== (favorite.notes ?? "")) {
              await api.updateFavorite(favorite.property_id, { notes: notes || null }).catch((error) => toast.error(errorMessage(error)));
              await refresh();
            }
          }}
          className="min-h-[38px] py-1.5 text-xs"
        />
        <div className="w-40">
          <Select
            aria-label="Watchlist"
            value={favorite.watchlist_id ?? ""}
            onChange={async (e) => {
              await api.updateFavorite(favorite.property_id, { watchlist_id: e.target.value || null }).catch((error) => toast.error(errorMessage(error)));
              await refresh();
            }}
          >
            <option value="">No watchlist</option>
            {watchlists.map((list) => (
              <option key={list.id} value={list.id}>
                {list.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
    </div>
  );
}

function SavedContent() {
  const { user, loading } = useSession();
  const { defaultsOrNull, weights, hydrated } = useApp();
  const client = useQueryClient();
  const router = useRouter();
  const params = useSearchParams();
  const tab = params.get("tab") ?? "properties";
  const [activeList, setActiveList] = React.useState<string>("all");
  const [newList, setNewList] = React.useState("");

  const favorites = useQuery({ queryKey: ["favorites", user?.id, defaultsOrNull, weights], queryFn: () => api.favorites(defaultsOrNull, weights), enabled: !!user && hydrated });
  const watchlists = useQuery({ queryKey: ["watchlists", user?.id], queryFn: api.watchlists, enabled: !!user });
  const searches = useQuery({ queryKey: ["saved-searches", user?.id], queryFn: api.savedSearches, enabled: !!user });
  const analyses = useQuery({ queryKey: ["saved-analyses", user?.id], queryFn: api.savedAnalyses, enabled: !!user });

  if (loading) return <div className="p-6"><Skeleton className="h-64 w-full" /></div>;
  if (!user) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-12">
        <EmptyState icon={<Bookmark />} title="Sign in to save properties and searches" action={<Button asChild><Link href="/login?next=/saved">Sign in or create an account</Link></Button>}>
          Accounts are optional. With one you can bookmark properties into watchlists, save searches with alerts, keep your financing assumptions and revisit past evaluations.
        </EmptyState>
      </div>
    );
  }

  const lists = watchlists.data ?? [];
  const shown = (favorites.data ?? []).filter((f) => activeList === "all" || (activeList === "none" ? !f.watchlist_id : f.watchlist_id === activeList));

  return (
    <div className="mx-auto max-w-[1440px] space-y-5 px-4 py-5 pb-24 lg:px-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Saved properties</h1>
        <p className="text-sm text-muted-foreground">Your watchlists, saved searches with alerts, and previous evaluations.</p>
      </div>

      <Tabs value={tab} onValueChange={(value) => router.replace(`/saved${value === "properties" ? "" : `?tab=${value}`}`, { scroll: false })}>
        <TabsList>
          <TabsTrigger value="properties">
            <Bookmark /> Properties {favorites.data ? <Badge>{favorites.data.length}</Badge> : null}
          </TabsTrigger>
          <TabsTrigger value="searches">
            <Search /> Searches {searches.data ? <Badge>{searches.data.length}</Badge> : null}
          </TabsTrigger>
          <TabsTrigger value="evaluations">
            <History /> Evaluations {analyses.data ? <Badge>{analyses.data.length}</Badge> : null}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="properties" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {[{ id: "all", name: "All saved" }, ...lists, { id: "none", name: "No watchlist" }].map((list) => (
              <span key={list.id} className="inline-flex items-center">
                <button
                  type="button"
                  aria-pressed={activeList === list.id}
                  onClick={() => setActiveList(list.id)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium ${activeList === list.id ? "border-primary bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:text-foreground"}`}
                >
                  {list.name}
                  {"property_count" in list ? ` (${(list as Watchlist).property_count})` : ""}
                </button>
                {"property_count" in list ? (
                  <button
                    type="button"
                    className="ml-0.5 rounded p-1 text-muted-foreground hover:text-negative"
                    aria-label={`Delete watchlist ${list.name}`}
                    onClick={async () => {
                      await api.deleteWatchlist(list.id);
                      if (activeList === list.id) setActiveList("all");
                      await Promise.all([client.invalidateQueries({ queryKey: ["watchlists"] }), client.invalidateQueries({ queryKey: ["favorites"] })]);
                    }}
                  >
                    <Trash2 className="size-3" />
                  </button>
                ) : null}
              </span>
            ))}
            <form
              className="ml-auto flex items-center gap-1.5"
              onSubmit={async (event) => {
                event.preventDefault();
                if (!newList.trim()) return;
                try {
                  await api.createWatchlist(newList.trim());
                  setNewList("");
                  await client.invalidateQueries({ queryKey: ["watchlists"] });
                } catch (error) {
                  toast.error(errorMessage(error));
                }
              }}
            >
              <Input aria-label="New watchlist name" placeholder="New watchlist" value={newList} maxLength={80} onChange={(e) => setNewList(e.target.value)} className="h-8 w-40 text-xs" />
              <Button type="submit" size="sm" variant="outline">
                <FolderPlus /> Add
              </Button>
            </form>
          </div>
          {favorites.isLoading ? (
            <Skeleton className="h-80 w-full" />
          ) : shown.length ? (
            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
              {shown.map((favorite) => (
                <FavoriteItem key={favorite.id} favorite={favorite} watchlists={lists} />
              ))}
            </div>
          ) : (
            <EmptyState icon={<Bookmark />} title={favorites.data?.length ? "Nothing in this watchlist" : "No saved properties yet"} action={<Button asChild><Link href="/search">Find properties</Link></Button>}>
              Use the bookmark button on any result card or analysis page.
            </EmptyState>
          )}
        </TabsContent>

        <TabsContent value="searches">
          {searches.isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : searches.data?.length ? (
            <Card className="overflow-hidden">
              <Table>
                <thead>
                  <tr>
                    <Th>Search</Th>
                    <Th>Alerts</Th>
                    <Th>Thresholds</Th>
                    <Th>Last checked</Th>
                    <Th className="text-right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {searches.data.map((search) => (
                    <tr key={search.id}>
                      <Td className="max-w-[420px]">
                        <span className="block truncate font-medium">{search.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">{describeFilters(search.filters as SearchFilters)}</span>
                      </Td>
                      <Td>
                        <label className="inline-flex items-center gap-2 text-xs">
                          <Switch
                            checked={search.alerts_enabled}
                            aria-label={`Alerts for ${search.name}`}
                            onCheckedChange={async (checked) => {
                              await api.updateSavedSearch(search.id, { alerts_enabled: checked }).catch((error) => toast.error(errorMessage(error)));
                              await client.invalidateQueries({ queryKey: ["saved-searches"] });
                            }}
                          />
                          {search.alerts_enabled ? (
                            <span className="inline-flex items-center gap-1 text-positive">
                              <Bell className="size-3.5" aria-hidden /> On
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-muted-foreground">
                              <BellOff className="size-3.5" aria-hidden /> Off
                            </span>
                          )}
                        </label>
                      </Td>
                      <Td className="text-xs text-muted-foreground">
                        {[
                          search.notify_new_listings ? "New listings" : null,
                          search.notify_price_reductions ? "Price drops" : null,
                          search.cash_flow_threshold != null ? `Cash flow ≥ ${usd(search.cash_flow_threshold)}` : null,
                          search.gross_yield_threshold != null ? `Yield ≥ ${pct(search.gross_yield_threshold)}` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </Td>
                      <Td className="text-xs text-muted-foreground">{search.last_checked_at ? relativeTime(search.last_checked_at) : "Not yet"}</Td>
                      <Td className="text-right">
                        <div className="flex justify-end gap-1.5">
                          <Button asChild size="sm">
                            <Link href={searchHref(search.filters as SearchFilters)}>
                              <Play /> Run
                            </Link>
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label={`Delete ${search.name}`}
                            onClick={async () => {
                              await api.deleteSavedSearch(search.id);
                              await client.invalidateQueries({ queryKey: ["saved-searches"] });
                            }}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          ) : (
            <EmptyState icon={<Search />} title="No saved searches" action={<Button asChild><Link href="/search">Start a search</Link></Button>}>
              Run a search and choose “Save search” to keep its filters and get alerts on new matches, price reductions, or cash-flow and yield targets.
            </EmptyState>
          )}
        </TabsContent>

        <TabsContent value="evaluations">
          {analyses.isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : analyses.data?.length ? (
            <Card className="overflow-hidden">
              <Table>
                <thead>
                  <tr>
                    <Th>Evaluation</Th>
                    <Th>Saved</Th>
                    <Th className="text-right">Price used</Th>
                    <Th>Recommendation</Th>
                    <Th className="text-right">LTR cash flow</Th>
                    <Th className="text-right">STR cash flow</Th>
                    <Th className="text-right">Score</Th>
                    <Th className="text-right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {analyses.data.map((item) => {
                    const summary = item.summary as { price?: number; recommendation?: string; long_term?: { monthly_cash_flow?: number | null }; short_term?: { monthly_cash_flow?: number | null } };
                    return (
                      <tr key={item.id}>
                        <Td className="max-w-[320px]">
                          <Link href={`/properties/${item.property_id}`} className="block truncate font-medium hover:underline">
                            {item.name ?? item.address}
                          </Link>
                          <span className="block truncate text-xs text-muted-foreground">{item.address}</span>
                        </Td>
                        <Td className="text-xs text-muted-foreground">{shortDate(item.created_at)}</Td>
                        <Td className="tnum text-right">{usd(summary.price)}</Td>
                        <Td className="text-xs">{summary.recommendation ?? "—"}</Td>
                        <Td className="tnum text-right">{usd(summary.long_term?.monthly_cash_flow)}</Td>
                        <Td className="tnum text-right">{usd(summary.short_term?.monthly_cash_flow)}</Td>
                        <Td className="tnum text-right font-semibold">{item.score != null ? item.score.toFixed(0) : "—"}</Td>
                        <Td className="text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label="Delete evaluation"
                            onClick={async () => {
                              await api.deleteSavedAnalysis(item.id);
                              await client.invalidateQueries({ queryKey: ["saved-analyses"] });
                            }}
                          >
                            <Trash2 />
                          </Button>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </Card>
          ) : (
            <EmptyState icon={<History />} title="No saved evaluations">
              On a property&apos;s analysis page choose “Save evaluation” to record the assumptions you used and the results at that moment.
            </EmptyState>
          )}
        </TabsContent>
      </Tabs>
      <CompareTray />
    </div>
  );
}

export default function SavedPage() {
  return (
    <React.Suspense fallback={<div className="p-6"><Skeleton className="h-64 w-full" /></div>}>
      <SavedContent />
    </React.Suspense>
  );
}
