"use client";

import Link from "next/link";
import { Bath, BedDouble, Bookmark, BookmarkCheck, Clock, ExternalLink, GitCompareArrows, LineChart, Ruler } from "lucide-react";
import { ConfidenceBadge, DemoTag, Metric, RuleBadges, ScoreRing } from "@/components/property/bits";
import { PropertyImage } from "@/components/property/property-image";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Hint } from "@/components/ui/overlays";
import { useApp, useFavoriteIds } from "@/lib/store";
import type { PropertyCard as CardData, StrategyFilter, StrategySummary } from "@/lib/types";
import { cn, num, pct, relativeTime, signTone, titleCase, usd } from "@/lib/utils";

/** The strategy whose numbers headline a card, matching the server's ranking rule. */
export function viewOf(card: CardData, strategy: StrategyFilter): { key: "ltr" | "str" | null; summary: StrategySummary | null } {
  if (strategy === "ltr") return { key: "ltr", summary: card.long_term };
  if (strategy === "str") return { key: "str", summary: card.short_term };
  if (card.primary_strategy === "str") return { key: "str", summary: card.short_term };
  if (card.primary_strategy === "ltr") return { key: "ltr", summary: card.long_term };
  return { key: null, summary: null };
}

const RENT_SOURCE_NOTE: Record<string, string> = {
  property_avm: "Property-level rent estimate with comparables",
  market_zip: "ZIP-level median rent for this bedroom count — request a detailed estimate on the analysis page",
  none: "No rent estimate available",
};

interface Props {
  card: CardData;
  strategy: StrategyFilter;
  selected?: boolean;
  onHover?: (id: string | null) => void;
  layout?: "grid" | "row";
}

export function PropertyCard({ card, strategy, selected, onHover, layout = "grid" }: Props) {
  const { toggleCompare, isCompared } = useApp();
  const favorites = useFavoriteIds();
  const { key, summary } = viewOf(card, strategy);
  const available = !!summary?.available;
  const score = strategy === "both" ? card.score : (summary?.score ?? null);
  const compared = isCompared(card.id);
  const saved = favorites.ids.has(card.id);
  const href = `/properties/${card.id}`;
  const strategyLabel = key === "str" ? "Short-term" : "Long-term";

  return (
    <Card
      data-testid="property-card"
      onMouseEnter={() => onHover?.(card.id)}
      onMouseLeave={() => onHover?.(null)}
      className={cn("group flex overflow-hidden transition-shadow hover:shadow-md", layout === "grid" ? "flex-col" : "flex-col sm:flex-row", selected && "ring-2 ring-[hsl(var(--ring))]")}
    >
      <Link href={href} className={cn("relative block shrink-0", layout === "grid" ? "aspect-[16/9] w-full" : "aspect-[16/9] w-full sm:aspect-auto sm:w-52")} tabIndex={-1} aria-hidden>
        <PropertyImage id={card.id} url={card.image_url} type={card.property_type} alt={card.formatted_address} className="size-full" />
        <div className="absolute left-2 top-2 flex gap-1">{card.is_demo ? <DemoTag /> : null}</div>
        <div className="absolute right-2 top-2">
          <ScoreRing score={score} size={46} />
        </div>
      </Link>

      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
        <div>
          <div className="flex items-start justify-between gap-2">
            <p className="tnum text-xl font-semibold leading-none tracking-tight">{usd(card.price)}</p>
            <ConfidenceBadge level={strategy === "both" ? card.confidence : (summary?.confidence ?? "insufficient")} short />
          </div>
          <Link href={href} className="mt-1.5 block truncate text-sm font-medium hover:underline" title={card.formatted_address}>
            {card.address_line1 ?? card.formatted_address}
          </Link>
          <p className="truncate text-xs text-muted-foreground">
            {[card.city, card.state].filter(Boolean).join(", ")} {card.zip_code} · {titleCase(card.property_type)}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <BedDouble className="size-3.5" aria-hidden /> {card.bedrooms ?? "—"} bd
            </span>
            <span className="inline-flex items-center gap-1">
              <Bath className="size-3.5" aria-hidden /> {card.bathrooms ?? "—"} ba
            </span>
            <span className="inline-flex items-center gap-1">
              <Ruler className="size-3.5" aria-hidden /> {card.square_feet ? `${num(card.square_feet)} sqft` : "sqft n/a"}
            </span>
            {card.days_on_market != null ? <span>{card.days_on_market} days on market</span> : null}
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-md bg-muted/50 p-2.5">
          <Metric
            label="Long-term rent"
            value={card.long_term.available ? `${usd(card.long_term.monthly_income)}/mo` : "Unavailable"}
            tone={card.long_term.available ? undefined : "text-muted-foreground font-medium"}
            hint={RENT_SOURCE_NOTE[card.rent_source]}
            sub={card.rent_source === "market_zip" ? "ZIP median" : card.rent_source === "property_avm" ? "Property estimate" : undefined}
          />
          <Metric
            label="Short-term revenue"
            value={card.short_term.available ? `${usd(card.short_term.monthly_income)}/mo` : "Unavailable"}
            tone={card.short_term.available ? undefined : "text-muted-foreground font-medium"}
            hint={card.short_term.available ? "Estimated gross short-term rental revenue per month (before costs)" : "No short-term rental estimate. Open the analysis to request one or enter your own nightly rate."}
            sub={card.legality_status !== "permitted" ? `STR: ${card.legality_label.toLowerCase()}` : "STR permitted"}
          />
        </dl>

        {available && summary ? (
          <dl className="grid grid-cols-3 gap-x-3 gap-y-2">
            <Metric label="Gross yield" value={pct(summary.gross_yield_pct)} hint={`${strategyLabel} annual gross income ÷ price`} />
            <Metric label="Cap rate" value={pct(summary.cap_rate_pct)} hint="Net operating income ÷ price (before financing)" />
            <Metric label="Cash-on-cash" value={pct(summary.cash_on_cash_pct)} tone={signTone(summary.cash_on_cash_pct)} hint="Annual pre-tax cash flow ÷ total cash invested" />
            <Metric label="Cash flow" value={`${usd(summary.monthly_cash_flow)}/mo`} tone={signTone(summary.monthly_cash_flow)} hint="After operating expenses and debt service" />
            <Metric label="Upfront cash" value={usd(summary.total_cash_invested)} hint="Down payment, closing, reserves and set-up costs" />
            <Metric label="Basis" value={strategyLabel} hint={card.recommendation} sub={card.recommendation_conditional ? "Verify STR rules" : undefined} />
          </dl>
        ) : (
          <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
            Returns can&apos;t be calculated yet — no {strategy === "str" ? "short-term rental" : "rental income"} estimate is available. Open the analysis to request one or enter
            your own.
          </p>
        )}

        <RuleBadges badges={card.badges} max={4} />

        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
          <Button asChild size="sm">
            <Link href={href}>
              <LineChart /> View analysis
            </Link>
          </Button>
          <Button variant={compared ? "secondary" : "outline"} size="sm" aria-pressed={compared} onClick={() => toggleCompare(card)}>
            <GitCompareArrows /> {compared ? "Comparing" : "Compare"}
          </Button>
          <Hint content={saved ? "Remove from saved properties" : "Save property"}>
            <Button variant="outline" size="icon" className="size-8" aria-label={saved ? "Remove from saved properties" : "Save property"} aria-pressed={saved} onClick={() => favorites.toggle(card.id)}>
              {saved ? <BookmarkCheck className="text-positive" /> : <Bookmark />}
            </Button>
          </Hint>
          {card.listing_url ? (
            <Hint content="Open original listing">
              <Button asChild variant="outline" size="icon" className="size-8">
                <a href={card.listing_url} target="_blank" rel="noopener noreferrer" aria-label="Open original listing in a new tab">
                  <ExternalLink />
                </a>
              </Button>
            </Hint>
          ) : (
            <Hint content={card.is_demo ? "Demo property — there is no real listing to open." : `${card.listing_source ?? "The data provider"} does not supply a link to the original listing page.`}>
              <span tabIndex={0}>
                <Button variant="outline" size="icon" className="size-8" disabled aria-label="Original listing link unavailable">
                  <ExternalLink />
                </Button>
              </span>
            </Hint>
          )}
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground" title={card.last_seen_at ?? undefined}>
            <Clock className="size-3" aria-hidden />
            {card.listing_source ?? "Listing"} · seen {relativeTime(card.last_seen_at)}
          </span>
        </div>
      </div>
    </Card>
  );
}
