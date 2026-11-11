"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Bookmark, MapPin } from "lucide-react";
import { SearchExperience } from "@/components/search/search-experience";
import { Skeleton } from "@/components/ui/card";
import { api } from "@/lib/api";
import { describeFilters, searchHref } from "@/lib/filters";
import { useSession, useStatus } from "@/lib/store";
import type { SearchFilters } from "@/lib/types";

interface Starter {
  label: string;
  sub: string;
  filters: SearchFilters;
  sort?: string;
}

const LIVE_STARTERS: Starter[] = [
  { label: "Memphis, TN", sub: "ZIP 38116 · high-yield market", filters: { zip_codes: ["38116"], strategy: "ltr" } },
  { label: "Peachtree City, GA", sub: "ZIP 30269 · suburban", filters: { zip_codes: ["30269"], strategy: "ltr" } },
  { label: "Indianapolis, IN", sub: "ZIP 46201 · cash-flow market", filters: { zip_codes: ["46201"], strategy: "ltr" } },
];

const DEMO_STARTERS: Starter[] = [
  { label: "Atlanta, GA", sub: "ZIP 30310 · gross yield ≥ 8%", filters: { zip_codes: ["30310"], min_gross_yield: 8, strategy: "ltr" } },
  { label: "Peachtree City, GA", sub: "ZIP 30269 · best cash-on-cash", filters: { zip_codes: ["30269"], strategy: "ltr" }, sort: "cash_on_cash" },
  { label: "Memphis, TN", sub: "ZIP 38116 · positive cash flow", filters: { zip_codes: ["38116"], min_cash_flow: 1, strategy: "ltr" }, sort: "cash_flow" },
];

const PRINCIPLES: [string, string][] = [
  ["Every listing in the ZIP", "Each home for sale is modelled as a long-term rental with rent, expenses and financing."],
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
          <div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Find rental properties that pay</h1>
              <p className="mt-1 text-sm text-muted-foreground">Search any US ZIP code. Every listing is ranked by cash flow, yield and risk-adjusted return.</p>
            </div>
          </div>
        }
        idle={<QuickStart />}
      />
    </React.Suspense>
  );
}
