"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { HeroScene } from "@/components/marketing/hero-scene";
import { Reveal, TaglineReveal } from "@/components/marketing/reveal";
import { SearchExperience } from "@/components/search/search-experience";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/card";
import { ArrowRight, Bookmark, ChevronDown, Gauge, LineChart, MapPin, Search, ShieldAlert, SlidersHorizontal } from "@/components/ui/icons";
import { api } from "@/lib/api";
import { describeFilters, searchHref } from "@/lib/filters";
import { useSession, useStatus } from "@/lib/store";
import type { SearchFilters } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Starter {
  label: string;
  sub: string;
  filters: SearchFilters;
  sort?: string;
}

const LIVE_STARTERS: Starter[] = [
  { label: "Memphis, TN", sub: "ZIP 38116 · high yield market", filters: { zip_codes: ["38116"], strategy: "ltr" } },
  { label: "Peachtree City, GA", sub: "ZIP 30269 · suburban", filters: { zip_codes: ["30269"], strategy: "ltr" } },
  { label: "Indianapolis, IN", sub: "ZIP 46201 · cash flow market", filters: { zip_codes: ["46201"], strategy: "ltr" } },
];

const DEMO_STARTERS: Starter[] = [
  { label: "Atlanta, GA", sub: "ZIP 30310 · gross yield 8% or more", filters: { zip_codes: ["30310"], min_gross_yield: 8, strategy: "ltr" } },
  { label: "Peachtree City, GA", sub: "ZIP 30269 · best cash on cash", filters: { zip_codes: ["30269"], strategy: "ltr" }, sort: "cash_on_cash" },
  { label: "Memphis, TN", sub: "ZIP 38116 · positive cash flow", filters: { zip_codes: ["38116"], min_cash_flow: 1, strategy: "ltr" }, sort: "cash_flow" },
];

const BENEFITS: { icon: React.ComponentType<{ className?: string }>; title: string; body: string }[] = [
  { icon: MapPin, title: "Every listing in the ZIP", body: "Each home for sale is modelled as a long term rental with rent, expenses and a mortgage." },
  { icon: Gauge, title: "Ranked by real returns", body: "Cash flow, cap rate and cash on cash are calculated with financing, not guessed from price or rent alone." },
  { icon: ShieldAlert, title: "Honest about data", body: "Every figure is labelled as sourced, estimated or a default, with a confidence rating." },
];

const STEPS: { icon: React.ComponentType<{ className?: string }>; title: string; body: string }[] = [
  { icon: Search, title: "Enter a ZIP code", body: "We load every active listing there and screen it against your filters." },
  { icon: LineChart, title: "See every home ranked", body: "Each home gets a rent estimate, its running costs and a mortgage, then a score out of 100." },
  { icon: SlidersHorizontal, title: "Test your own deal", body: "Open any home and slide the price, down payment, rate and rent to see your returns change." },
];

const FAQ: [string, string][] = [
  ["Where does the data come from?", "Listings and rent estimates come from RentCast. Every figure on a property is labelled as sourced, estimated or a default, so you can see what to verify."],
  ["How is monthly cash flow calculated?", "Rent minus vacancy, property tax, insurance, management, maintenance, a capital reserve and the mortgage payment. The defaults are 25% down at 7% over 30 years, and you can change all of them."],
  ["Can I use my own numbers?", "Yes. Open any property and use the deal simulator to change the price, down payment, interest rate, rent and costs. Every metric updates as you go."],
  ["How many searches do I get?", "Each search covers one ZIP code. A free account includes your first search, and paid plans add more searches every month. See Plans & pricing for details."],
  ["Does it cover vacation rentals?", "No. Every home is evaluated as a long term rental."],
  ["Is this financial advice?", "No. The estimates and projections are for research only. Verify listings, rents and taxes independently before you invest."],
];

function focusSearch() {
  const input = document.getElementById("f-location") as HTMLInputElement | null;
  window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  input?.focus({ preventScroll: true });
}

function Hero({ compact }: { compact: boolean }) {
  const { data: status } = useStatus();
  const { user } = useSession();
  if (compact) {
    return (
      <div>
        <h1 className="heading-5 text-balance">Find rental properties that pay</h1>
        <p className="body-6 mt-1 text-pretty text-muted-foreground">Every listing in the ZIP code, ranked by cash flow, yield and risk adjusted return.</p>
      </div>
    );
  }
  const demo = status?.data_mode === "demo";
  return (
    <div>
      {/* Two lines, broken where the thought breaks; on phones the text flows and balances. */}
      <h1 className="heading-4 hero-gradient max-w-[680px] text-balance pb-1 sm:heading-3 lg:heading-4 xl:heading-2">
        Know what a rental earns <br className="hidden sm:block" />
        <span className="text-brand">before you make an offer</span>
      </h1>
      <p className="body-3 mt-4 max-w-[680px] text-pretty text-muted-foreground">
        Enter a US ZIP code. Every home for sale there is modelled as a long term rental and ranked by cash flow, cap rate and cash on cash return.
      </p>
      <p className="caption-4 mt-3 text-pretty text-muted-foreground" data-testid="proof-line">
        {demo ? "Demo mode: sample listings for a set of demo ZIP codes" : "Listing and rent data from RentCast"}
        {!user ? " · Your first ZIP search is free" : null}
      </p>
    </div>
  );
}

/** 3D neighbourhood with floating glass cards. The figures are an illustration, and say so. */
function HeroVisual() {
  return (
    <figure className="relative">
      <div className="relative h-72 sm:h-80 lg:h-[400px]">
        <HeroScene className="absolute inset-0" />
        <div className="glass-card float-a absolute left-0 top-6 sm:left-4" aria-hidden>
          <p className="caption-5 text-muted-foreground">Cash flow</p>
          <p className="tnum body-1 text-positive">+$612 / mo</p>
        </div>
        <div className="glass-card float-b absolute right-0 top-1/3 sm:right-2" aria-hidden>
          <p className="caption-5 text-muted-foreground">Cash on cash</p>
          <p className="tnum body-1">14.7%</p>
        </div>
        <div className="glass-card float-c absolute bottom-6 left-6 flex items-center gap-3 sm:left-12" aria-hidden>
          <span className="tnum caption-3 flex size-10 items-center justify-center rounded-full border-4 border-positive/70 text-positive">88</span>
          <span>
            <span className="caption-5 block text-muted-foreground">Investment score</span>
            <span className="body-4 block">Strong</span>
          </span>
        </div>
      </div>
      <figcaption className="caption-5 text-center text-muted-foreground">Illustration with example figures</figcaption>
    </figure>
  );
}

function SectionHeading({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="max-w-[680px]">
      <h2 className="heading-5 text-balance">{title}</h2>
      {sub ? <p className="body-6 mt-1 text-pretty text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

function FaqItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  return (
    <div className="glass rounded-xl">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
          className="title-3 flex w-full items-center justify-between gap-4 rounded-xl px-4 py-3 text-left transition-colors hover:bg-muted/60"
        >
          {question}
          <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-500", open && "rotate-180")} aria-hidden />
        </button>
      </h3>
      {open ? (
        <p id={id} className="body-6 text-pretty px-4 pb-4 text-muted-foreground">
          {answer}
        </p>
      ) : null}
    </div>
  );
}

function QuickStart() {
  const { data: status } = useStatus();
  const { user, loading } = useSession();
  const saved = useQuery({ queryKey: ["saved-searches", user?.id], queryFn: api.savedSearches, enabled: !!user });
  const starters = status?.data_mode === "demo" ? DEMO_STARTERS : LIVE_STARTERS;
  const guest = !loading && !user;

  return (
    <div className="space-y-16 pt-2">
      {saved.data?.length ? (
        <section className="space-y-4">
          <SectionHeading title="Your saved searches" />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {saved.data.slice(0, 6).map((search) => (
              <Link
                key={search.id}
                href={searchHref(search.filters as SearchFilters)}
                className="tilt-card glass group flex items-center gap-3 rounded-xl px-4 py-3"
              >
                <Bookmark className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="title-4 block truncate">{search.name}</span>
                  <span className="caption-5 block truncate text-muted-foreground">{describeFilters(search.filters as SearchFilters)}</span>
                </span>
                <ArrowRight className="size-4 text-muted-foreground transition-transform duration-500 group-hover:translate-x-0.5" aria-hidden />
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section className="space-y-4">
        <SectionHeading title="Try a market" sub="One click runs a ready made search." />
        <div className="grid gap-3 sm:grid-cols-3">
          {starters.map((starter) => (
            <Link
              key={starter.label}
              href={searchHref(starter.filters, { sort: starter.sort, base: "/" })}
              className="tilt-card glass group flex items-center gap-3 rounded-xl px-4 py-3"
            >
              <span className="btn-brand flex size-10 shrink-0 items-center justify-center rounded-full">
                <MapPin className="size-5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="title-4 block truncate">{starter.label}</span>
                <span className="caption-5 block truncate text-muted-foreground">{starter.sub}</span>
              </span>
              <ArrowRight className="size-4 text-muted-foreground transition-transform duration-500 group-hover:translate-x-0.5" aria-hidden />
            </Link>
          ))}
        </div>
      </section>

      <Reveal className="space-y-4" aria-labelledby="benefits-title">
        <h2 id="benefits-title" className="sr-only">
          What you get
        </h2>
        <div className="grid gap-6 sm:grid-cols-3">
          {BENEFITS.map(({ icon: Icon, title, body }) => (
            <div key={title} className="space-y-2">
              <span className="depth-tile flex size-12 items-center justify-center rounded-xl">
                <Icon className="size-6" aria-hidden />
              </span>
              <h3 className="title-3">{title}</h3>
              <p className="body-6 text-pretty text-muted-foreground">{body}</p>
            </div>
          ))}
        </div>
      </Reveal>

      {guest ? (
        <>
          <Reveal className="space-y-6" aria-labelledby="how-title">
            <div className="max-w-[680px]">
              <h2 id="how-title" className="heading-5 text-balance">
                How it works
              </h2>
            </div>
            <ol className="grid gap-4 lg:grid-cols-3">
              {STEPS.map(({ icon: Icon, title, body }, i) => (
                <li key={title} className="tilt-card glass rounded-2xl p-6">
                  <div className="flex items-center gap-3">
                    <span className="btn-brand caption-3 tnum flex size-8 items-center justify-center rounded-full">{i + 1}</span>
                    <Icon className="size-5 text-muted-foreground" aria-hidden />
                  </div>
                  <h3 className="title-2 mt-4">{title}</h3>
                  <p className="body-6 mt-1 text-pretty text-muted-foreground">{body}</p>
                </li>
              ))}
            </ol>
          </Reveal>

          <section aria-label="What PropertyYield does" className="py-16">
            <TaglineReveal className="heading-3" lines={["Every home for sale,", "priced as a rental and ranked", "by the cash it puts in your pocket."]} />
          </section>

          <Reveal className="space-y-6" aria-labelledby="faq-title">
            <SectionHeading title="Questions investors ask" />
            <div className="grid max-w-3xl gap-3">
              {FAQ.map(([q, a]) => (
                <FaqItem key={q} question={q} answer={a} />
              ))}
            </div>
          </Reveal>

          <Reveal className="glass ring-brand rounded-2xl px-6 py-12 text-center">
            <h2 className="heading-5 mx-auto max-w-[680px] text-balance">Check your first ZIP code free</h2>
            <p className="body-6 mx-auto mt-2 max-w-[680px] text-pretty text-muted-foreground">Create a free account and see every home for sale ranked by cash flow. No card required.</p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Button size="lg" onClick={focusSearch}>
                <Search /> Find rentals
              </Button>
            </div>
          </Reveal>
        </>
      ) : null}
    </div>
  );
}

export default function DashboardPage() {
  return (
    <React.Suspense fallback={<div className="p-6"><Skeleton className="h-40 w-full" /></div>}>
      <SearchExperience basePath="/" heading={(active) => <Hero compact={active} />} heroAside={<HeroVisual />} idle={<QuickStart />} />
    </React.Suspense>
  );
}
