"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Search } from "@/components/ui/icons";
import { SERIES, SimpleBarChart, TrendChart } from "@/components/property/charts";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Skeleton, Table, Td, Th } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/form";
import { api, errorMessage } from "@/lib/api";
import { US_STATES } from "@/lib/filters";
import { useStatus } from "@/lib/store";
import type { ZipMarket } from "@/lib/types";
import { num, pct, relativeTime, usd, usdCompact } from "@/lib/utils";

function ZipCard({ market }: { market: ZipMarket }) {
  const stats = market.stats;
  const history = (stats.history ?? []).map((point) => ({ ...point }));
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            ZIP {stats.zip_code}
            {market.city ? <span className="text-sm font-normal text-muted-foreground">{market.city}, {market.state}</span> : null}
            {stats.is_demo ? <Badge tone="demo">Demo</Badge> : null}
          </CardTitle>
          <CardDescription>
            Source: {stats.provider === "demo" ? "Demo dataset" : stats.provider} · retrieved {relativeTime(stats.fetched_at)}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
          {[
            ["Median asking price", usd(stats.median_sale_price)],
            ["Median rent", `${usd(stats.median_rent)}/mo`],
            ["Gross yield (median)", pct(market.gross_yield_pct, 2)],
            ["Price-to-rent ratio", market.price_to_rent_ratio != null ? market.price_to_rent_ratio.toFixed(1) : "—"],
            ["Price per sqft", usd(stats.median_price_per_sqft)],
            ["Listings for sale", num(stats.sale_listings)],
            ["Days on market", stats.sale_median_days_on_market != null ? num(stats.sale_median_days_on_market) : "—"],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-[11px] text-muted-foreground">{label}</dt>
              <dd className="tnum text-base font-semibold">{value}</dd>
            </div>
          ))}
        </dl>

        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">Median rent, last 12 months</p>
            {history.length > 1 ? <TrendChart rows={history} dataKey="median_rent" name="Median rent" color={SERIES.ltr} format={(v) => usd(v)} /> : <p className="text-sm text-muted-foreground">No rent history available.</p>}
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">Median asking price, last 12 months</p>
            {history.length > 1 ? <TrendChart rows={history} dataKey="median_sale_price" name="Median asking price" color={SERIES.third} format={(v) => usdCompact(v)} /> : <p className="text-sm text-muted-foreground">No price history available.</p>}
          </div>
        </div>

        {market.yield_by_bedrooms?.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Bedrooms</Th>
                <Th className="text-right">Median rent</Th>
                <Th className="text-right">Median asking price</Th>
                <Th className="text-right">Gross yield</Th>
                <Th className="text-right">Rental listings</Th>
                <Th className="text-right">Sale listings</Th>
              </tr>
            </thead>
            <tbody>
              {market.yield_by_bedrooms.map((row) => (
                <tr key={row.bedrooms}>
                  <Td>{row.bedrooms} bedroom{row.bedrooms === 1 ? "" : "s"}</Td>
                  <Td className="tnum text-right">{usd(row.median_rent)}</Td>
                  <Td className="tnum text-right">{usd(row.median_price)}</Td>
                  <Td className="tnum text-right font-medium">{pct(row.gross_yield_pct, 2)}</Td>
                  <Td className="tnum text-right text-muted-foreground">{row.rental_sample}</Td>
                  <Td className="tnum text-right text-muted-foreground">{row.sale_sample}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}
      </CardContent>
    </Card>
  );
}

function MarketContent() {
  const router = useRouter();
  const params = useSearchParams();
  const { data: status } = useStatus();
  const zipParam = params.get("zips") ?? "";
  const cityParam = params.get("city") ?? "";
  const stateParam = params.get("state") ?? "";
  const [zips, setZips] = React.useState(zipParam);
  const [city, setCity] = React.useState(cityParam);
  const [state, setState] = React.useState(stateParam);
  const [formError, setFormError] = React.useState<string | null>(null);

  const zipList = zipParam.split(/[\s,;]+/).filter(Boolean);
  const active = zipList.length > 0 || !!cityParam;
  const query = useQuery({
    queryKey: ["market", zipParam, cityParam, stateParam],
    queryFn: () => api.market(zipList.length ? { zip_codes: zipList } : { city: cityParam, state: stateParam || undefined }),
    enabled: active,
    retry: false,
  });
  const data = query.data;

  const go = (next: { zips?: string; city?: string; state?: string }) => {
    const search = new URLSearchParams();
    if (next.zips) search.set("zips", next.zips);
    if (next.city) search.set("city", next.city);
    if (next.state) search.set("state", next.state);
    router.push(`/market?${search}`, { scroll: false });
  };

  return (
    <div className="mx-auto max-w-[1440px] space-y-5 px-4 py-5 lg:px-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Market analytics</h1>
        <p className="text-sm text-muted-foreground">ZIP-level rent, price and yield statistics from active listings — context for judging an individual property&apos;s numbers.</p>
      </div>

      <Card className="p-4 sm:p-5">
        <form
          className="grid grid-cols-2 items-end gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            const list = zips.split(/[\s,;]+/).filter(Boolean);
            const bad = list.find((z) => !/^\d{5}$/.test(z));
            if (bad) return setFormError(`“${bad}” is not a 5-digit ZIP code.`);
            if (!list.length && !city.trim()) return setFormError("Enter ZIP codes, or a city.");
            setFormError(null);
            go(list.length ? { zips: list.slice(0, 8).join(",") } : { city: city.trim(), state });
          }}
        >
          <Field label="ZIP codes (up to 8)" htmlFor="m-zips" className="col-span-2 md:col-span-1">
            <Input id="m-zips" placeholder="30310, 30318" value={zips} onChange={(e) => setZips(e.target.value)} inputMode="numeric" />
          </Field>
          <Field label="…or a city you have searched" htmlFor="m-city" className="col-span-2 md:col-span-1">
            <Input id="m-city" placeholder="Atlanta" value={city} onChange={(e) => setCity(e.target.value)} />
          </Field>
          <Field label="State" htmlFor="m-state">
            <Select id="m-state" value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">Any</option>
              {US_STATES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit">
            <Search /> Analyse market
          </Button>
        </form>
        {formError ? <Alert tone="error" className="mt-3">{formError}</Alert> : null}
        {status?.data_mode === "demo" ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            Demo markets:
            {status.demo_markets.slice(0, 8).map((m) => (
              <button key={`${m.city}-${m.state}`} type="button" className="rounded-full border bg-card px-2 py-0.5 hover:text-foreground" onClick={() => { setZips(m.zip_codes); setCity(""); go({ zips: m.zip_codes.replace(/\s/g, "") }); }}>
                {m.city}, {m.state}
              </button>
            ))}
          </div>
        ) : null}
      </Card>

      {!active ? (
        <EmptyState icon={<BarChart3 />} title="Choose a market">
          Enter one or more ZIP codes to compare typical rents, asking prices and gross yields. Each ZIP uses one provider request and is cached for {status?.freshness?.market_stats_days ?? 7} days.
        </EmptyState>
      ) : null}
      {query.isLoading ? <Skeleton className="h-96 w-full" /> : null}
      {query.error ? <Alert tone="error">{errorMessage(query.error)}</Alert> : null}

      {data ? (
        <>
          {data.notes.map((note) => (
            <Alert key={note} tone="info">
              {note}
            </Alert>
          ))}
          {data.unavailable.length ? <Alert tone="warning">No market data is available for: {data.unavailable.join(", ")}.</Alert> : null}

          {data.markets.length > 1 ? (
            <Card>
              <CardHeader>
                <CardTitle>Gross yield by ZIP code</CardTitle>
                <CardDescription>{data.methodology}</CardDescription>
              </CardHeader>
              <CardContent>
                <SimpleBarChart rows={data.markets.map((m) => ({ zip: m.stats.zip_code, yield: m.gross_yield_pct }))} xKey="zip" dataKey="yield" name="Gross yield" color={SERIES.ltr} format={(v) => `${v.toFixed(1)}%`} />
              </CardContent>
            </Card>
          ) : data.markets.length === 1 ? (
            <p className="text-xs text-muted-foreground">{data.methodology}</p>
          ) : null}

          {data.markets.map((market) => (
            <ZipCard key={market.stats.zip_code} market={market} />
          ))}
        </>
      ) : null}
    </div>
  );
}

export default function MarketPage() {
  return (
    <React.Suspense fallback={<div className="p-6"><Skeleton className="h-64 w-full" /></div>}>
      <MarketContent />
    </React.Suspense>
  );
}
