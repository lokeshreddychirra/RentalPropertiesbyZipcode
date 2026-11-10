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

function Overview() {
  const { data: status } = useStatus();
  const { user } = useSession();
  const usage = useQuery({ queryKey: ["usage"], queryFn: api.usage, staleTime: 60_000 });
  const favorites = useQuery({ queryKey: ["favorite-ids", user?.id], queryFn: api.favoriteIds, enabled: !!user });
  const saved = useQuery({ queryKey: ["saved-searches", user?.id], queryFn: api.savedSearches, enabled: !!user });

  const listings = usage.data?.providers.find((p) => p.key === "rentcast");
  const spend = usage.data?.providers.reduce((sum, p) => sum + p.estimated_cost_this_month_usd, 0) ?? 0;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {status ? (
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
      )}
      <Tile
        icon={<Gauge />}
        label="API usage this month"
        value={status?.data_mode === "demo" ? "No paid calls" : listings ? `${listings.requests_this_month.toLocaleString()} requests` : "—"}
        sub={
          status?.data_mode === "demo"
            ? "Demo mode makes no provider requests"
            : listings?.monthly_request_limit
              ? `${listings.request_budget_used_pct ?? 0}% of listing budget · est. $${spend.toFixed(2)}`
              : `Estimated $${spend.toFixed(2)}`
        }
        href="/settings#usage"
      />
      <Tile icon={<Bookmark />} label="Saved properties" value={user ? (favorites.data?.length ?? "—") : "Sign in"} sub={user ? "Watchlists and notes" : "Save properties and assumptions"} href={user ? "/saved" : "/login"} />
      <Tile icon={<Search />} label="Saved searches" value={user ? (saved.data?.length ?? "—") : "Sign in"} sub={user ? `${saved.data?.filter((s) => s.alerts_enabled).length ?? 0} with alerts` : "Get alerts on new matches"} href={user ? "/saved?tab=searches" : "/login"} />
    </div>
  );
}

function QuickStart() {
  const { data: status } = useStatus();
  const { user } = useSession();
  const saved = useQuery({ queryKey: ["saved-searches", user?.id], queryFn: api.savedSearches, enabled: !!user });

  const starters: { label: string; filters: SearchFilters; sort?: string }[] =
    status?.data_mode === "demo"
      ? [
          { label: "Atlanta, GA · $150k–$400k · gross yield ≥ 8%", filters: { cities: ["Atlanta, GA"], min_price: 150000, max_price: 400000, min_gross_yield: 8, strategy: "both" } },
          { label: "Peachtree City 30269 · highest cash-on-cash", filters: { zip_codes: ["30269"], strategy: "both" }, sort: "cash_on_cash" },
          { label: "Florida short-term rentals under $400k", filters: { state: "FL", max_price: 400000, strategy: "str" }, sort: "str_return" },
          { label: "Memphis, TN · positive cash flow", filters: { cities: ["Memphis, TN"], min_cash_flow: 1, strategy: "ltr" }, sort: "cash_flow" },
        ]
      : [];

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold">Start with a search</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Enter a city, ZIP code or state above. Every matching listing is analysed as both a long-term and a short-term rental, then ranked by calculated returns — not by
        price or estimated rent alone.
      </p>
      {starters.length || saved.data?.length ? (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {(saved.data ?? []).slice(0, 4).map((search) => (
            <Link key={search.id} href={searchHref(search.filters as SearchFilters)} className="group flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm hover:border-foreground/30">
              <Bookmark className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{search.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{describeFilters(search.filters as SearchFilters)}</span>
              </span>
              <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
            </Link>
          ))}
          {starters.map((starter) => (
            <Link key={starter.label} href={searchHref(starter.filters, { sort: starter.sort, base: "/" })} className="group flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm hover:border-foreground/30">
              <MapPin className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate font-medium">{starter.label}</span>
              <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
            </Link>
          ))}
        </div>
      ) : null}
    </Card>
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
              <h1 className="text-2xl font-semibold tracking-tight">Investment dashboard</h1>
              <p className="text-sm text-muted-foreground">Find residential properties with the strongest rental yield, cash flow and risk-adjusted return.</p>
            </div>
            <Overview />
          </div>
        }
        idle={<QuickStart />}
      />
    </React.Suspense>
  );
}
