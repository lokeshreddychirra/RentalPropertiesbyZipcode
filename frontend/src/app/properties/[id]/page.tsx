"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bookmark, BookmarkCheck, ExternalLink, GitCompareArrows, Save, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import { MapView } from "@/components/map/map-view";
import { AssumptionsPanel } from "@/components/property/assumptions-panel";
import { DemoTag, RuleBadges } from "@/components/property/bits";
import { ReturnComparisonChart } from "@/components/property/charts";
import { PropertyImage } from "@/components/property/property-image";
import {
  AISection,
  ComparablesTable,
  FinancialModel,
  FinancingSection,
  ForecastSection,
  Freshness,
  HeadlineMetrics,
  RecommendationCard,
  RiskSection,
  ScenarioSection,
  StrategyComparisonTable,
  StrategyToggle,
  type CustomLoan,
} from "@/components/property/sections";
import { CompareTray } from "@/components/search/search-experience";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Skeleton, Table, Td, Th } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTrigger, Hint, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/overlays";
import { api, ApiError, errorMessage, type AnalysisBody } from "@/lib/api";
import { useApp, useFavoriteIds, useSession, useStatus } from "@/lib/store";
import type { AssumptionOverrides, AssumptionSection, PropertyDetail, Strategy } from "@/lib/types";
import { cn, num, pct, relativeTime, shortDate, titleCase, usd } from "@/lib/utils";

const INCLUDE: AnalysisBody["include"] = ["forecast", "scenarios", "sensitivity", "financing"];

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function Gallery({ detail }: { detail: PropertyDetail }) {
  const ctx = detail.context;
  const [active, setActive] = React.useState(0);
  const images = detail.images;
  return (
    <div className="space-y-2">
      <PropertyImage id={ctx.id} url={images[active]?.url} type={ctx.property_type} alt={ctx.formatted_address} caption className="aspect-[16/9] w-full rounded-lg border" />
      {images.length > 1 ? (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {images.slice(0, 12).map((image, i) => (
            <button key={image.url} type="button" onClick={() => setActive(i)} aria-label={`Show photo ${i + 1}`} className={cn("h-14 w-20 shrink-0 overflow-hidden rounded border", i === active && "ring-2 ring-[hsl(var(--ring))]")}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image.url} alt="" className="size-full object-cover" loading="lazy" referrerPolicy="no-referrer" />
            </button>
          ))}
        </div>
      ) : null}
      {images[active]?.attribution ? <p className="text-[11px] text-muted-foreground">Photo: {images[active].attribution}</p> : null}
    </div>
  );
}

function ListingFacts({ detail }: { detail: PropertyDetail }) {
  const ctx = detail.context;
  const facts: [string, React.ReactNode][] = [
    ["Property type", titleCase(ctx.property_type)],
    ["Bedrooms / bathrooms", `${ctx.bedrooms ?? "—"} / ${ctx.bathrooms ?? "—"}`],
    ["Living area", ctx.square_feet ? `${num(ctx.square_feet)} sqft` : "Not reported"],
    ["Price per sqft", ctx.square_feet && ctx.price ? usd(ctx.price / ctx.square_feet) : "—"],
    ["Lot size", detail.lot_size_sqft ? `${num(detail.lot_size_sqft)} sqft` : "Not reported"],
    ["Year built", ctx.year_built ?? "Not reported"],
    ["Listing status", <Badge key="s" tone={ctx.status === "active" ? "positive" : "warning"}>{ctx.status === "active" ? "Active — for sale" : titleCase(ctx.status)}</Badge>],
    ["Days on market", ctx.days_on_market ?? "—"],
    ["Listed", shortDate(ctx.listed_date)],
    ["HOA fee", ctx.hoa_fee_monthly != null ? `${usd(ctx.hoa_fee_monthly)}/mo` : "Not reported"],
    ["Property tax", ctx.property_tax_annual != null ? `${usd(ctx.property_tax_annual)}/yr · ${ctx.property_tax_source ?? ""}` : "Not reported — estimated"],
    ["County", ctx.county ?? "—"],
    ["MLS", detail.mls_name ? `${detail.mls_name}${detail.mls_number ? ` #${detail.mls_number}` : ""}` : "—"],
    ["Listing agent / office", [detail.agent_name, detail.office_name].filter(Boolean).join(" · ") || "—"],
    ["Listing data source", ctx.listing_sources.join(", ") || ctx.listing_source || "—"],
    ["Last confirmed", ctx.last_seen_at ? `${relativeTime(ctx.last_seen_at)} (${shortDate(ctx.last_seen_at)})` : "Unknown"],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
      {facts.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-[11px] text-muted-foreground">{label}</dt>
          <dd className="truncate text-sm font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function PropertyPage() {
  const { id } = useParams<{ id: string }>();
  const client = useQueryClient();
  const { defaultsOrNull, weights, hydrated, toggleCompare, isCompared } = useApp();
  const { user } = useSession();
  const { data: status } = useStatus();
  const favorites = useFavoriteIds();
  const isDemoMode = status?.data_mode === "demo";

  const [overrides, setOverrides] = React.useState<AssumptionOverrides>({});
  const [customLoans, setCustomLoans] = React.useState<CustomLoan[]>([]);
  const [strategy, setStrategy] = React.useState<Strategy | null>(null);
  const [tab, setTab] = React.useState("overview");
  const debouncedOverrides = useDebounced(overrides, 250);

  const detail = useQuery({ queryKey: ["property", id], queryFn: () => api.property(id), retry: false });
  const ctx = detail.data?.context;

  // Opening the analysis is a request for detail: fetch the property-level rent estimate.
  const rent = useQuery({ queryKey: ["rent-estimate", id], queryFn: () => api.rentEstimate(id, true), enabled: !!ctx, staleTime: 5 * 60_000, retry: false });
  // Value and STR estimates are premium calls: automatic in demo mode, on request with live providers.
  const [wantValue, setWantValue] = React.useState(false);
  const [wantStr, setWantStr] = React.useState(false);
  const value = useQuery({ queryKey: ["value-estimate", id, wantValue || isDemoMode], queryFn: () => api.valueEstimate(id, wantValue || !!isDemoMode), enabled: !!ctx && !!status, staleTime: 5 * 60_000, retry: false });
  const strEstimate = useQuery({ queryKey: ["str-estimate", id, wantStr || isDemoMode], queryFn: () => api.strEstimate(id, wantStr || !!isDemoMode), enabled: !!ctx && !!status, staleTime: 5 * 60_000, retry: false });

  // New estimates change the analysis inputs: refresh dependent data once they arrive.
  const estimateStamp = `${rent.data?.fetched_at ?? ""}|${value.data?.fetched_at ?? ""}|${strEstimate.data?.fetched_at ?? ""}`;
  React.useEffect(() => {
    if (rent.data?.fetched_now || value.data?.fetched_now || strEstimate.data?.fetched_now) {
      void client.invalidateQueries({ queryKey: ["property", id] });
    }
  }, [estimateStamp, rent.data?.fetched_now, value.data?.fetched_now, strEstimate.data?.fetched_now, client, id]);

  const body: AnalysisBody = React.useMemo(
    () => ({ property_id: id, overrides: debouncedOverrides, defaults: defaultsOrNull, weights, include: INCLUDE, custom_financing: customLoans }),
    [id, debouncedOverrides, defaultsOrNull, weights, customLoans],
  );
  const analysisKey = JSON.stringify([body, estimateStamp]);
  const analysisQuery = useQuery({
    queryKey: ["analysis", analysisKey],
    queryFn: ({ signal }) => api.calculate(body, signal),
    enabled: !!ctx && hydrated,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const analysis = analysisQuery.data;
  const activeStrategy: Strategy = strategy ?? analysis?.primary_strategy ?? "ltr";
  const pending = analysisQuery.isFetching || debouncedOverrides !== overrides;

  const setField = React.useCallback((section: AssumptionSection, field: string, next: number | boolean | null | undefined) => {
    setOverrides((current) => {
      const group = { ...((current[section] ?? {}) as Record<string, unknown>) };
      if (next === undefined) delete group[field];
      else group[field] = next;
      const result = { ...current } as Record<string, unknown>;
      if (Object.keys(group).length) result[section] = group;
      else delete result[section];
      return result as AssumptionOverrides;
    });
  }, []);

  if (detail.isLoading) {
    return (
      <div className="mx-auto max-w-[1440px] space-y-4 px-4 py-5 lg:px-6">
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-72 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (detail.error || !detail.data || !ctx) {
    const notFound = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <div className="mx-auto max-w-2xl px-4 py-16">
        <EmptyState title={notFound ? "Property not found" : "This property could not be loaded"} action={<Button asChild><Link href="/search">Back to search</Link></Button>}>
          {notFound ? "It may have been removed, or the link is from a different data mode (demo vs live)." : errorMessage(detail.error)}
        </EmptyState>
      </div>
    );
  }

  const data = detail.data;
  const saved = favorites.ids.has(id);
  const compared = isCompared(id);
  const analysisError = analysisQuery.error ? errorMessage(analysisQuery.error) : null;

  const assumptionsPanel = analysis ? (
    <AssumptionsPanel analysis={analysis} overrides={overrides} onChange={setField} onResetAll={() => setOverrides({})} pending={pending} />
  ) : (
    <Skeleton className="h-96 w-full" />
  );

  const saveEvaluation = async () => {
    if (!user) {
      toast.info("Sign in to save evaluations");
      return;
    }
    try {
      await api.saveAnalysis({ property_id: id, name: `${ctx.address_line1 ?? "Evaluation"} · ${new Date().toLocaleDateString()}`, overrides, defaults: defaultsOrNull, weights });
      toast.success("Evaluation saved — find it under Saved Properties");
      void client.invalidateQueries({ queryKey: ["saved-analyses"] });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <div className="mx-auto max-w-[1440px] px-4 py-5 pb-24 lg:px-6">
      <Link href="/search" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" onClick={(event) => { if (window.history.length > 1) { event.preventDefault(); window.history.back(); } }}>
        <ArrowLeft className="size-4" aria-hidden /> Back to results
      </Link>

      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{ctx.address_line1 ?? ctx.formatted_address}</h1>
            {ctx.is_demo ? <DemoTag /> : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {[data.address_line2, ctx.city, ctx.state].filter(Boolean).join(", ")} {ctx.zip_code} · {ctx.bedrooms ?? "—"} bd · {ctx.bathrooms ?? "—"} ba · {ctx.square_feet ? `${num(ctx.square_feet)} sqft` : "sqft n/a"}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <p className="tnum text-3xl font-semibold tracking-tight">{usd(ctx.price)}</p>
            {ctx.price_reduction ? (
              <span className="text-sm text-muted-foreground">
                <s>{usd(ctx.price_reduction.previous_price)}</s> · reduced {pct(ctx.price_reduction.percent)} on {shortDate(ctx.price_reduction.changed_on)}
              </span>
            ) : null}
          </div>
          {analysis ? (
            <div className="mt-2">
              <RuleBadges badges={analysis.badges} />
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline" className="xl:hidden">
                <SlidersHorizontal /> Assumptions
              </Button>
            </DialogTrigger>
            <DialogContent side="right" title="Assumptions" description="Changes recalculate every metric on this page.">
              {assumptionsPanel}
            </DialogContent>
          </Dialog>
          <Button variant={saved ? "secondary" : "outline"} aria-pressed={saved} onClick={() => favorites.toggle(id)}>
            {saved ? <BookmarkCheck className="text-positive" /> : <Bookmark />} {saved ? "Saved" : "Save property"}
          </Button>
          <Button variant={compared ? "secondary" : "outline"} aria-pressed={compared} onClick={() => toggleCompare({ id, formatted_address: ctx.formatted_address, price: ctx.price ?? null })}>
            <GitCompareArrows /> {compared ? "Comparing" : "Compare"}
          </Button>
          <Hint content={user ? "Save these assumptions and results to review later" : "Sign in to save evaluations"}>
            <Button variant="outline" onClick={saveEvaluation}>
              <Save /> Save evaluation
            </Button>
          </Hint>
          {ctx.listing_url ? (
            <Button asChild>
              <a href={ctx.listing_url} target="_blank" rel="noopener noreferrer">
                <ExternalLink /> Open original listing
              </a>
            </Button>
          ) : (
            <Hint content={ctx.is_demo ? "Demo property — there is no real listing to open." : `${ctx.listing_source ?? "The data provider"} does not supply a link to the original listing page. Use the MLS number to look it up.`}>
              <span tabIndex={0}>
                <Button disabled>
                  <ExternalLink /> Original listing unavailable
                </Button>
              </span>
            </Hint>
          )}
        </div>
      </header>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          {analysisError ? (
            <Alert tone="error" title="These assumptions could not be calculated">
              {analysisError}
            </Alert>
          ) : null}
          {analysis ? <RecommendationCard analysis={analysis} /> : <Skeleton className="h-20 w-full" />}
          {analysis ? <div className={cn(pending && "opacity-70 transition-opacity")}><HeadlineMetrics analysis={analysis} /></div> : <Skeleton className="h-56 w-full" />}

          <Tabs value={tab} onValueChange={setTab}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="scrollbar-thin max-w-full overflow-x-auto">
                <TabsList>
                  <TabsTrigger value="overview">Overview</TabsTrigger>
                  <TabsTrigger value="financials">Financial model</TabsTrigger>
                  <TabsTrigger value="forecast">Forecast</TabsTrigger>
                  <TabsTrigger value="financing">Financing</TabsTrigger>
                  <TabsTrigger value="scenarios">Scenarios</TabsTrigger>
                  <TabsTrigger value="risk">Risk &amp; data</TabsTrigger>
                  <TabsTrigger value="ai">AI analysis</TabsTrigger>
                  <TabsTrigger value="comps">Comparables</TabsTrigger>
                </TabsList>
              </div>
              {analysis && ["financials", "forecast", "financing", "scenarios"].includes(tab) ? <StrategyToggle value={activeStrategy} onChange={setStrategy} analysis={analysis} /> : null}
            </div>

            <TabsContent value="overview" className="space-y-5">
              <div className="grid gap-5 lg:grid-cols-2">
                <Gallery detail={data} />
                {ctx.latitude != null && ctx.longitude != null ? (
                  <MapView
                    className="aspect-[16/9] w-full"
                    points={[{ id: ctx.id, latitude: ctx.latitude, longitude: ctx.longitude, price: ctx.price, gross_yield_pct: analysis?.long_term.gross_yield_pct ?? null, monthly_cash_flow: null, score: null, address: ctx.address_line1 ?? ctx.formatted_address }]}
                    secondary={(rent.data?.comparables ?? []).filter((c) => c.latitude != null && c.longitude != null).map((c) => ({ latitude: c.latitude as number, longitude: c.longitude as number, label: `Rental comp: ${c.formatted_address}` }))}
                  />
                ) : (
                  <div className="flex aspect-[16/9] items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">No coordinates available for this listing</div>
                )}
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>Listing details</CardTitle>
                  <CardDescription>{data.attribution.join(" · ") || "Listing data"}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <ListingFacts detail={data} />
                  {data.description ? <p className="border-t pt-4 text-sm leading-relaxed text-muted-foreground">{data.description}</p> : <p className="border-t pt-4 text-xs text-muted-foreground">No listing description is supplied by the data provider.</p>}
                </CardContent>
              </Card>

              {analysis ? (
                <Card>
                  <CardHeader>
                    <CardTitle>Investment returns</CardTitle>
                    <CardDescription>Gross, operating and leveraged returns for each strategy under your assumptions.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ReturnComparisonChart analysis={analysis} />
                  </CardContent>
                </Card>
              ) : null}

              {analysis ? <StrategyComparisonTable analysis={analysis} /> : null}

              <Card>
                <CardHeader>
                  <CardTitle>Property history</CardTitle>
                  <CardDescription>Listing and price events reported by the data source.</CardDescription>
                </CardHeader>
                <CardContent className="px-0 pb-0">
                  {data.price_history.length ? (
                    <Table>
                      <thead>
                        <tr>
                          <Th className="pl-5">Date</Th>
                          <Th>Event</Th>
                          <Th className="text-right">Price</Th>
                          <Th className="pr-5">Source</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...data.price_history].reverse().map((event, i) => (
                          <tr key={`${event.event_date}-${event.event_type}-${i}`}>
                            <Td className="tnum pl-5">{shortDate(event.event_date)}</Td>
                            <Td>{titleCase(event.event_type)}</Td>
                            <Td className="tnum text-right">{usd(event.price)}</Td>
                            <Td className="pr-5 text-xs text-muted-foreground">{event.source}</Td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  ) : (
                    <p className="px-5 pb-5 text-sm text-muted-foreground">No listing history is available.</p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="financials">{analysis ? <FinancialModel analysis={analysis} strategy={activeStrategy} /> : <Skeleton className="h-96 w-full" />}</TabsContent>
            <TabsContent value="forecast">{analysis ? <ForecastSection analysis={analysis} strategy={activeStrategy} /> : <Skeleton className="h-96 w-full" />}</TabsContent>
            <TabsContent value="financing">
              {analysis ? <FinancingSection analysis={analysis} strategy={activeStrategy} custom={customLoans} onCustomChange={setCustomLoans} /> : <Skeleton className="h-96 w-full" />}
            </TabsContent>
            <TabsContent value="scenarios">{analysis ? <ScenarioSection analysis={analysis} strategy={activeStrategy} /> : <Skeleton className="h-96 w-full" />}</TabsContent>
            <TabsContent value="risk">{analysis ? <RiskSection analysis={analysis} /> : <Skeleton className="h-96 w-full" />}</TabsContent>
            <TabsContent value="ai">
              <AISection body={{ property_id: id, overrides: debouncedOverrides, defaults: defaultsOrNull, weights }} analysisKey={analysisKey} />
            </TabsContent>

            <TabsContent value="comps" className="space-y-5">
              <Card>
                <CardHeader>
                  <CardTitle>Long-term rent estimate</CardTitle>
                  <CardDescription>{rent.data?.available ? <Freshness provider={rent.data.provider} fetchedAt={rent.data.fetched_at} demo={rent.data.is_demo} /> : "Estimated monthly rent and the comparable rentals behind it."}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 px-0 pb-0">
                  {rent.isLoading ? (
                    <div className="px-5 pb-5"><Skeleton className="h-24 w-full" /></div>
                  ) : rent.data?.available ? (
                    <>
                      <dl className="grid grid-cols-2 gap-4 px-5 sm:grid-cols-4">
                        {[
                          ["Low estimate", usd(rent.data.rent_low)],
                          ["Base estimate", usd(rent.data.rent)],
                          ["High estimate", usd(rent.data.rent_high)],
                          ["Annual gross", usd(rent.data.annual_gross)],
                        ].map(([label, v]) => (
                          <div key={label}>
                            <dt className="text-[11px] text-muted-foreground">{label}</dt>
                            <dd className="tnum text-lg font-semibold">{v}</dd>
                          </div>
                        ))}
                      </dl>
                      {analysis?.long_term.available ? (
                        <p className="px-5 text-xs text-muted-foreground">
                          Used in the model: {usd(analysis.assumptions.long_term.monthly_rent)}/mo · vacancy {analysis.assumptions.long_term.vacancy_pct}% · effective gross income {usd(analysis.long_term.effective_gross_income)}/yr.
                          {analysis.provenance["long_term.monthly_rent"] === "user" ? " You have overridden the estimate." : " Override it under Assumptions → Long-term rental."}
                        </p>
                      ) : null}
                      {rent.data.level === "market_zip" ? (
                        <div className="px-5">
                          <Alert tone="warning">
                            {rent.data.reason} Based on {rent.data.market_sample} rental listings in ZIP {ctx.zip_code}.
                          </Alert>
                        </div>
                      ) : (
                        <ComparablesTable comparables={rent.data.comparables} priceLabel="Rent" perMonth />
                      )}
                    </>
                  ) : (
                    <div className="px-5 pb-5">
                      <Alert tone="warning" title="Rent estimate unavailable">
                        {rent.data?.reason ?? "No reliable estimate could be retrieved."} Enter a monthly rent under Assumptions to model the long-term rental scenario.
                      </Alert>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Short-term rental estimate</CardTitle>
                  <CardDescription>{strEstimate.data?.available ? <Freshness provider={strEstimate.data.provider} fetchedAt={strEstimate.data.fetched_at} demo={strEstimate.data.is_demo} /> : "Nightly rate and occupancy from a short-term rental analytics provider."}</CardDescription>
                </CardHeader>
                <CardContent>
                  {strEstimate.isLoading ? (
                    <Skeleton className="h-20 w-full" />
                  ) : strEstimate.data?.available ? (
                    <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
                      {[
                        ["Average daily rate", usd(strEstimate.data.adr, { cents: true })],
                        ["Occupancy", pct(strEstimate.data.occupancy_pct)],
                        ["Provider annual revenue", usd(strEstimate.data.annual_revenue)],
                        ["Average stay", strEstimate.data.avg_stay_nights ? `${strEstimate.data.avg_stay_nights} nights` : "—"],
                        ["Comparable listings", String(strEstimate.data.comp_count)],
                      ].map(([label, v]) => (
                        <div key={label}>
                          <dt className="text-[11px] text-muted-foreground">{label}</dt>
                          <dd className="tnum text-lg font-semibold">{v}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <Alert tone="warning" title="Short-term rental estimate unavailable">
                      {strEstimate.data?.reason}
                      {strEstimate.data?.can_request ? (
                        <>
                          {" "}
                          <button type="button" className="font-medium underline" onClick={() => setWantStr(true)}>
                            Request an estimate (uses one provider credit)
                          </button>
                        </>
                      ) : null}
                    </Alert>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Comparable properties for sale</CardTitle>
                  <CardDescription>{value.data?.available ? <Freshness provider={value.data.provider} fetchedAt={value.data.fetched_at} demo={value.data.is_demo} /> : "Automated value estimate and the comparable sale listings behind it."}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 px-0 pb-0">
                  {value.isLoading ? (
                    <div className="px-5 pb-5"><Skeleton className="h-24 w-full" /></div>
                  ) : value.data?.available ? (
                    <>
                      <dl className="grid grid-cols-2 gap-4 px-5 sm:grid-cols-4">
                        {[
                          ["Low value", usd(value.data.value_low)],
                          ["Estimated value", usd(value.data.value)],
                          ["High value", usd(value.data.value_high)],
                          ["Asking price vs estimate", value.data.value && ctx.price ? pct(((ctx.price - value.data.value) / value.data.value) * 100) : "—"],
                        ].map(([label, v]) => (
                          <div key={label}>
                            <dt className="text-[11px] text-muted-foreground">{label}</dt>
                            <dd className="tnum text-lg font-semibold">{v}</dd>
                          </div>
                        ))}
                      </dl>
                      <ComparablesTable comparables={value.data.comparables} priceLabel="Price" />
                    </>
                  ) : (
                    <div className="px-5 pb-5">
                      <Alert tone="info" title="No value estimate yet">
                        {value.data?.reason}
                        {value.data?.can_request ? (
                          <>
                            {" "}
                            <button type="button" className="font-medium underline" onClick={() => setWantValue(true)}>
                              Request value estimate and comparables (uses one provider credit)
                            </button>
                          </>
                        ) : null}
                      </Alert>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>

        <aside className="hidden xl:block">
          <div className="scrollbar-thin sticky top-[4.5rem] max-h-[calc(100vh-5.5rem)] overflow-y-auto pb-4 pr-1">{assumptionsPanel}</div>
        </aside>
      </div>
      <CompareTray />
    </div>
  );
}
