"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
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
  { icon: MapPin, title: "Every home, not a shortlist", body: "Every listing for sale in the ZIP code is analysed, so the best deal never hides on page three." },
  { icon: Gauge, title: "Cash flow after every cost", body: "Rent minus vacancy, taxes, insurance, management, repairs and the mortgage. What is left is what you keep." },
  { icon: ShieldAlert, title: "Know what to double check", body: "Every figure is marked as sourced, estimated or a default, with a confidence rating." },
];

const STEPS: { icon: React.ComponentType<{ className?: string }>; title: string; body: string }[] = [
  { icon: Search, title: "Enter a ZIP code", body: "Any US ZIP code. We pull every home for sale there and the rents around it." },
  { icon: LineChart, title: "See the best deals first", body: "Each home gets a rent estimate, its running costs, a mortgage and a score out of 100." },
  { icon: SlidersHorizontal, title: "Make it your deal", body: "Open any home and change the price, down payment, rate and rent. Your returns update as you type." },
];

/** "Your first ZIP search is free" / "Your first 2 ZIP searches are free", from the live Free plan. */
function useFreeSearches(): number | null {
  const plans = useQuery({ queryKey: ["plans"], queryFn: api.plans, staleTime: 60_000 });
  const free = plans.data?.plans.find((plan) => plan.key === "free");
  return free?.zip_searches ?? null;
}

function freeSearchesLabel(count: number | null): string {
  if (!count || count <= 1) return "Your first ZIP search is free";
  return `Your first ${count} ZIP searches are free`;
}

const faq = (freeLabel: string): [string, string][] => [
  ["Where does the data come from?", "Listings and rent estimates come from RentCast. Every figure on a property is labelled as sourced, estimated or a default, so you can see what to verify."],
  ["How is monthly cash flow calculated?", "Rent minus vacancy, property tax, insurance, management, maintenance, a capital reserve and the mortgage payment. The defaults are 25% down at 7% over 30 years, and you can change all of them."],
  ["Can I use my own numbers?", "Yes. Open any property and use the deal simulator to change the price, down payment, interest rate, rent and costs. Every metric updates as you go."],
  ["How fast is a search?", "Most ZIP codes are ready in a few seconds. Larger ones show the first homes straight away while the rest load."],
  ["Do I need a credit card?", `No. ${freeLabel} with a free account. Paid plans add more searches every month; see Plans & pricing.`],
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
  return <FullHero demo={status?.data_mode === "demo"} guest={!user} />;
}

function FullHero({ demo, guest }: { demo: boolean; guest: boolean }) {
  const free = useFreeSearches();
  return (
    <div>
      <h1 className="heading-4 hero-gradient text-balance pb-1 lg:heading-3">
        Type a ZIP code. <br className="hidden sm:block" />
        <span className="text-brand">See which homes pay you every month.</span>
      </h1>
      <p className="body-3 mt-3 max-w-[620px] text-pretty text-muted-foreground">
        We run the numbers on every home for sale there as a long term rental and rank them by the cash they leave in your pocket.
      </p>
      <p className="caption-4 mt-2 text-pretty text-muted-foreground" data-testid="proof-line">
        {demo ? "Demo mode: sample listings for a set of demo ZIP codes" : "Live listings and rents from RentCast · Every home analysed, not a sample"}
        {guest ? ` · ${freeSearchesLabel(free)}, no card needed` : null}
      </p>
    </div>
  );
}

/** Investing wisdom beside the headline: one line at a time, rotating gently. */
const QUOTES: { text: string; by?: string }[] = [
  { text: "Don't wait to buy real estate. Buy real estate and wait.", by: "Investor proverb" },
  { text: "You make your money when you buy, not when you sell.", by: "Investor proverb" },
  { text: "Price is what you pay. Value is what you get.", by: "Warren Buffett" },
  { text: "Your tenants pay the mortgage. You keep the house." },
  { text: "Buy the cash flow, not the hype." },
  { text: "Know the numbers before you fall in love with the kitchen." },
  { text: "A good rental pays you every month. A great one pays you again when you sell." },
];

const QUOTE_SECONDS = 6;

function HeroQuotes() {
  const [index, setIndex] = React.useState(0);
  const [paused, setPaused] = React.useState(false);
  React.useEffect(() => {
    if (paused || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % QUOTES.length), QUOTE_SECONDS * 1000);
    return () => window.clearInterval(timer);
  }, [paused]);
  const quote = QUOTES[index];
  return (
    <figure
      className="relative border-l-2 border-primary/60 pl-5 lg:pl-6"
      aria-label="Quotes on investing in rental property"
      data-testid="hero-quotes"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <p className="caption-4 text-muted-foreground">Words to invest by</p>
      {/* Fixed height so the row never jumps as quotes of different lengths rotate. */}
      <div className="mt-2 flex min-h-[96px] flex-col justify-center lg:min-h-[112px]" aria-live="polite">
        <blockquote key={index} className="animate-in fade-in slide-in-from-bottom-1 duration-500">
          <p className="heading-6 text-balance lg:heading-5">&ldquo;{quote.text}&rdquo;</p>
          {quote.by ? <footer className="body-6 mt-1.5 text-muted-foreground">{quote.by}</footer> : null}
        </blockquote>
      </div>
      <div className="mt-2 flex items-center gap-1.5" aria-label="Choose a quote">
        {QUOTES.map((q, i) => (
          <button
            key={q.text}
            type="button"
            aria-current={i === index ? "true" : undefined}
            aria-label={`Quote ${i + 1} of ${QUOTES.length}`}
            onClick={() => setIndex(i)}
            className={cn("h-1.5 rounded-full transition-all", i === index ? "w-6 bg-primary" : "w-1.5 bg-muted-foreground/40 hover:bg-muted-foreground/70")}
          />
        ))}
      </div>
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
  const free = useFreeSearches();

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
        <SectionHeading title="Not sure where to start? Try a market" sub="One click runs a ready made search, ranked and ready to compare." />
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
            <TaglineReveal className="heading-3" lines={["Stop guessing which homes cash flow.", "Search a ZIP code and see", "every one ranked in seconds."]} />
          </section>

          <Reveal className="space-y-6" aria-labelledby="faq-title">
            <SectionHeading title="Questions investors ask" />
            <div className="grid max-w-3xl gap-3">
              {faq(freeSearchesLabel(free)).map(([q, a]) => (
                <FaqItem key={q} question={q} answer={a} />
              ))}
            </div>
          </Reveal>

          <Reveal className="glass ring-brand rounded-2xl px-6 py-12 text-center">
            <h2 className="heading-5 mx-auto max-w-[680px] text-balance">See which homes in your ZIP code cash flow</h2>
            <p className="body-6 mx-auto mt-2 max-w-[680px] text-pretty text-muted-foreground">
              {freeSearchesLabel(free)} with a free account. No card, no sales call, results in seconds.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Button size="lg" onClick={focusSearch}>
                <Search /> Search a ZIP code
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
      <SearchExperience basePath="/" heading={(active) => <Hero compact={active} />} idle={<QuickStart />} heroAside={<HeroQuotes />} />
    </React.Suspense>
  );
}
