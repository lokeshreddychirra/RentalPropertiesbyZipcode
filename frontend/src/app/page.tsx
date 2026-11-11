"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Bookmark, Database, Gauge, MapPin, Search } from "lucide-react";
import { SearchExperience } from "@/components/search/search-experience";
import { Card, Skeleton } from "@/components/ui/card";
import { api } from "@/lib/api";
import { describeFilters, searchHref } from "@/lib/filters";
import { useSession, useStatus } from "@/lib/store";
import type { SearchFilters } from "@/lib/types";
import { cn } from "@/lib/utils";

function Tile({ icon, label, value, sub, href, tone }: { icon: React.ReactNode; label: string; value: React.ReactNode; sub: React.ReactNode; href?: string; tone?: string }) {
  const body = (
    <Card className={cn("flex h-full items-start gap-3 p-4", href && "transition-shadow hover:shadow-md")}>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">{icon}</span>
      <span className="min-w-0">
        <span className="block text-xs text-muted-foreground">{label}</span>
        <span className={cn("tnum block truncate text-lg font-semibold leading-tight", tone)}>{value}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{sub}</span>
      </span>
    </Card>
  );
  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

/** Account tiles: saved items for signed-in users, plus data source and API usage for administrators. */
function Overview() {
  const { data: status } = useStatus();
  const { user } = useSession();
  const isAdmin = user?.role === "admin";
  const usage = useQuery({ queryKey: ["usage"], queryFn: api.usage, staleTime: 60_000, enabled: isAdmin });
  const favorites = useQuery({ queryKey: ["favorite-ids", user?.id], queryFn: api.favoriteIds, enabled: !!user });
  const saved = useQuery({ queryKey: ["saved-searches", user?.id], queryFn: api.savedSearches, enabled: !!user });
  if (!user) return null;

  const listings = usage.data?.providers.find((p) => p.key === "rentcast");
  const spend = usage.data?.providers.reduce((sum, p) => sum + p.estimated_cost_this_month_usd, 0) ?? 0;

  return (
    <div className={cn("grid grid-cols-2 gap-3", isAdmin ? "lg:grid-cols-4" : "max-w-xl")}>
      {isAdmin ? (
        status ? (
          <Tile
            icon={<Database />}
            label="Data source"
            value={status.data_mode === "live" ? "Live listings" : "Demo dataset"}
            tone={status.data_mode === "live" ? "text-positive" : "text-[#5b21b6]"}
            sub={status.data_mode === "live" ? "RentCast connected" : "Sample properties — not real listings"}
            href="/settings#data-sources"
          />
        ) : (
          <Skeleton className="h-[74px]" />
        )
      ) : null}
      {isAdmin ? (
        <Tile
          icon={<Gauge />}
          label="API usage this month"
          value={status?.data_mode === "demo" ? "No paid calls" : listings ? `${listings.requests_this_month.toLocaleString()} requests` : "—"}
          sub={
            status?.data_mode === "demo"
              ? "Demo mode makes no provider requests"
              : listings?.monthly_request_limit
                ? `${listings.requests_this_month} of ${listings.monthly_request_limit} allowed · est. $${spend.toFixed(2)}`
                : `Estimated $${spend.toFixed(2)}`
          }
          href="/settings#usage"
        />
      ) : null}
      <Tile icon={<Bookmark />} label="Saved properties" value={favorites.data?.length ?? "—"} sub="Watchlists and notes" href="/saved" />
      <Tile icon={<Search />} label="Saved searches" value={saved.data?.length ?? "—"} sub={`${saved.data?.filter((s) => s.alerts_enabled).length ?? 0} with alerts`} href="/saved?tab=searches" />
    </div>
  );
}

interface Starter {
  label: string;
  sub: string;
  filters: SearchFilters;
  sort?: string;
}

const LIVE_STARTERS: Starter[] = [
  { label: "Memphis, TN", sub: "ZIP 38116 · high-yield market", filters: { zip_codes: ["38116"], strategy: "both" } },
  { label: "Peachtree City, GA", sub: "ZIP 30269 · suburban", filters: { zip_codes: ["30269"], strategy: "both" } },
  { label: "Indianapolis, IN", sub: "ZIP 46201 · cash-flow market", filters: { zip_codes: ["46201"], strategy: "both" } },
];

const DEMO_STARTERS: Starter[] = [
  { label: "Atlanta, GA", sub: "ZIP 30310 · gross yield ≥ 8%", filters: { zip_codes: ["30310"], min_gross_yield: 8, strategy: "both" } },
  { label: "Peachtree City, GA", sub: "ZIP 30269 · best cash-on-cash", filters: { zip_codes: ["30269"], strategy: "both" }, sort: "cash_on_cash" },
  { label: "Memphis, TN", sub: "ZIP 38116 · positive cash flow", filters: { zip_codes: ["38116"], min_cash_flow: 1, strategy: "ltr" }, sort: "cash_flow" },
];

const PRINCIPLES: [string, string][] = [
  ["Every listing, both strategies", "Each home is modelled as a long-term and a short-term rental, and the stronger feasible one is recommended."],
  ["Ranked by real returns", "Cash flow, cap rate and cash-on-cash are calculated with financing — not guessed from price or rent alone."],
  ["Honest about data", "Every figure is labelled as sourced, estimated or default, with a confidence rating."],
];

function QuickStart() {
  const { data: status } = useStatus();
  const { user } = useSession();
  const saved = useQuery({ queryKey: ["saved-searches", user?.id], queryFn: api.savedSearches, enabled: !!user });
  const starters = status?.data_mode === "demo" ? DEMO_STARTERS : LIVE_STARTERS;

  return (
    <div className="space-y-6">
      {saved.data?.length ? (
        <section className="space-y-2.5">
          <h2 className="text-sm font-semibold">Your saved searches</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {saved.data.slice(0, 6).map((search) => (
              <Link key={search.id} href={searchHref(search.filters as SearchFilters)} className="group flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-sm hover:border-foreground/30">
                <Bookmark className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{search.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{describeFilters(search.filters as SearchFilters)}</span>
                </span>
                <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section className="space-y-2.5">
        <h2 className="text-sm font-semibold">Try a market</h2>
        <div className="grid gap-2 sm:grid-cols-3">
          {starters.map((starter) => (
            <Link
              key={starter.label}
              href={searchHref(starter.filters, { sort: starter.sort, base: "/" })}
              className="group flex items-center gap-3 rounded-lg border bg-card px-4 py-3 transition-shadow hover:shadow-md"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <MapPin className="size-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{starter.label}</span>
                <span className="block truncate text-xs text-muted-foreground">{starter.sub}</span>
              </span>
              <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
            </Link>
          ))}
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        {PRINCIPLES.map(([title, body]) => (
          <div key={title} className="rounded-lg border bg-card p-4">
            <h3 className="text-sm font-semibold">{title}</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{body}</p>
          </div>
        ))}
      </section>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <React.Suspense fallback={<div className="p-6"><Skeleton className="h-40 w-full" /></div>}>
      <SearchExperience
        basePath="/"
        heading={
          <div className="space-y-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Find rental properties that pay</h1>
              <p className="mt-1 text-sm text-muted-foreground">Search any US ZIP code. Every listing is ranked by cash flow, yield and risk-adjusted return.</p>
            </div>
            <Overview />
          </div>
        }
        idle={<QuickStart />}
      />
    </React.Suspense>
  );
}
