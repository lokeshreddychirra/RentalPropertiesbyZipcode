"use client";

import Link from "next/link";
import { Bath, BedDouble, Bookmark, BookmarkCheck, Clock, ExternalLink, GitCompareArrows, LineChart, Ruler } from "@/components/ui/icons";
import { ConfidenceBadge, DemoTag, Metric, RuleBadges, ScoreRing } from "@/components/property/bits";
import { PropertyImage } from "@/components/property/property-image";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Hint } from "@/components/ui/overlays";
import { useTilt } from "@/components/ui/tilt";
import { useApp, useFavoriteIds, useSession } from "@/lib/store";
import type { PropertyCard as CardData, StrategyFilter, StrategySummary } from "@/lib/types";
import { cn, num, pct, relativeTime, signTone, titleCase, usd } from "@/lib/utils";

/** The strategy whose numbers headline a card, matching the server's ranking rule. */
export function viewOf(card: CardData, strategy: StrategyFilter): { key: "ltr" | "str" | null; summary: StrategySummary | null } {
  // Long-term rental only.
  void strategy;
  return { key: "ltr", summary: card.long_term };
}

const RENT_SOURCE_NOTE: Record<string, string> = {
  property_avm: "Property level rent estimate with comparables",
  market_zip: "Conservative ZIP level screening estimate, not specific to this property. Open the analysis to request a property level estimate.",
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
  const { user } = useSession();
  const { summary } = viewOf(card, strategy);
  const available = !!summary?.available;
  const score = card.score ?? summary?.score ?? null;
  const compared = isCompared(card.id);
  const saved = favorites.ids.has(card.id);
  const href = `/properties/${card.id}`;
  const tilt = useTilt<HTMLDivElement>(4);

  return (
    <Card
      data-testid="property-card"
      onMouseEnter={() => onHover?.(card.id)}
      onMouseLeave={() => onHover?.(null)}
      {...(layout === "grid" ? tilt : {})}
      className={cn("group flex overflow-hidden", layout === "grid" && "tilt-3d", layout === "grid" ? "flex-col" : "flex-col sm:flex-row", selected && "ring-2 ring-[hsl(var(--ring))]")}
    >
      <Link href={href} className={cn("relative block shrink-0", layout === "grid" ? (card.image_url ? "aspect-[16/9] w-full" : "aspect-[16/6] w-full") : "aspect-[16/6] w-full sm:aspect-auto sm:w-52")} tabIndex={-1} aria-hidden>
        <PropertyImage id={card.id} url={card.image_url} type={card.property_type} alt={card.formatted_address} className="size-full" />
        <div className="absolute left-2 top-2 flex gap-1">{card.is_demo ? <DemoTag /> : null}</div>
        <div className="absolute right-2 top-2">
          <ScoreRing score={score} size={46} />
        </div>
      </Link>

      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
        <div>
          <div className="flex items-start justify-between gap-2">
            <p className="tnum heading-6">{usd(card.price)}</p>
            <ConfidenceBadge level={card.confidence} short />
          </div>
          <Link href={href} className="title-4 mt-1 block truncate hover:underline" title={card.formatted_address}>
            {card.address_line1 ?? card.formatted_address}
          </Link>
          <p className="caption-5 truncate text-muted-foreground">
            {[card.city, card.state].filter(Boolean).join(", ")} {card.zip_code} · {titleCase(card.property_type)}
          </p>
          <div className="caption-5 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
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

        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-[var(--glass-border)] bg-muted/50 p-3">
          <Metric
            label="Monthly rent"
            value={card.long_term.available ? `${usd(card.long_term.monthly_income)}/mo` : "Unavailable"}
            tone={card.long_term.available ? undefined : "text-muted-foreground font-medium"}
            hint={RENT_SOURCE_NOTE[card.rent_source]}
            sub={card.rent_source === "market_zip" ? "ZIP level estimate" : card.rent_source === "property_avm" ? "Property estimate" : undefined}
          />
          <Metric
            label="Price per sqft"
            value={card.price && card.square_feet ? usd(card.price / card.square_feet) : "—"}
            hint="List price ÷ living area"
            sub={card.square_feet ? `${card.square_feet.toLocaleString()} sqft` : undefined}
          />
        </dl>

        {available && summary ? (
          <dl className="grid grid-cols-3 gap-x-3 gap-y-2">
            <Metric label="Gross yield" value={pct(summary.gross_yield_pct)} hint="Annual rent ÷ price" />
            <Metric label="Cap rate" value={pct(summary.cap_rate_pct)} hint="Net operating income ÷ price (before financing)" />
            <Metric label="Cash on cash" value={pct(summary.cash_on_cash_pct)} tone={signTone(summary.cash_on_cash_pct)} hint="Annual pre-tax cash flow ÷ total cash invested" />
            <Metric label="Cash flow" value={`${usd(summary.monthly_cash_flow)}/mo`} tone={signTone(summary.monthly_cash_flow)} hint="After operating expenses and debt service" />
            <Metric label="Upfront cash" value={usd(summary.total_cash_invested)} hint="Down payment, closing, reserves and setup costs" />
            <Metric label="DSCR" value={summary.dscr != null ? `${Number(summary.dscr).toFixed(2)}×` : "N/A"} hint="Net operating income ÷ annual mortgage payments (1.25× or more is comfortable)" />
          </dl>
        ) : (
          <p className="caption-5 rounded-lg border border-dashed px-3 py-2 text-muted-foreground">
            Returns can&apos;t be calculated yet because no rent estimate is available. Open the analysis to request one or
            enter your own.
          </p>
        )}

        <RuleBadges badges={card.badges} max={4} />

        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
          <Button asChild size="sm">
            <Link href={href}>
              <LineChart /> View analysis
            </Link>
          </Button>
          <Button variant={compared ? "secondary" : "outline"} size="sm" aria-pressed={compared} onClick={() => toggleCompare(card)}>
            <GitCompareArrows /> {compared ? "Comparing" : "Compare"}
          </Button>
          {user ? (
            <Hint content={saved ? "Remove from saved properties" : "Save property"}>
              <Button variant="outline" size="icon" className="size-8" aria-label={saved ? "Remove from saved properties" : "Save property"} aria-pressed={saved} onClick={() => favorites.toggle(card.id)}>
                {saved ? <BookmarkCheck className="text-positive" /> : <Bookmark />}
              </Button>
            </Hint>
          ) : null}
          {card.listing_url ? (
            <Hint content="Open original listing">
              <Button asChild variant="outline" size="icon" className="size-8">
                <a href={card.listing_url} target="_blank" rel="noopener noreferrer" aria-label="Open original listing in a new tab">
                  <ExternalLink />
                </a>
              </Button>
            </Hint>
          ) : (
            <Hint content={card.is_demo ? "Demo property: there is no real listing to open." : `${card.listing_source ?? "The data provider"} does not supply a link to the original listing page.`}>
              <span tabIndex={0}>
                <Button variant="outline" size="icon" className="size-8" disabled aria-label="Original listing link unavailable">
                  <ExternalLink />
                </Button>
              </span>
            </Hint>
          )}
          <span className="caption-5 ml-auto inline-flex items-center gap-1 text-muted-foreground" title={card.last_seen_at ?? undefined}>
            <Clock className="size-3" aria-hidden />
            {card.listing_source ?? "Listing"} · seen {relativeTime(card.last_seen_at)}
          </span>
        </div>
      </div>
    </Card>
  );
}
