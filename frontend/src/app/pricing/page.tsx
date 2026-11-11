"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "@/components/ui/icons";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, Skeleton } from "@/components/ui/card";
import { useTilt } from "@/components/ui/tilt";
import { api, errorMessage } from "@/lib/api";
import { useAccount, useSession } from "@/lib/store";
import type { PlanInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

const limitText = (value: number | null | undefined, unit: string, monthly: boolean) =>
  value == null ? `Unlimited ${unit}` : `${value.toLocaleString()} ${unit}${monthly ? " / month" : ""}`;

function Meter({ label, used, limit }: { label: string; used: number; limit: number | null | undefined }) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="tnum font-medium">{limit == null ? `${used} used` : `${used} of ${limit}`}</span>
      </div>
      {limit != null ? (
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div className={cn("h-full rounded-full", pct >= 100 ? "bg-negative" : "bg-primary")} style={{ width: `${Math.max(pct, 2)}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function PlanCard({ plan, current, billing, featured }: { plan: PlanInfo; current: boolean; billing: boolean; featured: boolean }) {
  const tilt = useTilt<HTMLDivElement>(5);
  const { user } = useSession();
  const [busy, setBusy] = React.useState(false);
  const paid = plan.key !== "free";

  const upgrade = async () => {
    if (!billing) {
      toast.info("Online payment isn't switched on yet — contact the site administrator to upgrade your account.");
      return;
    }
    setBusy(true);
    try {
      const { url } = await api.checkout(plan.key as "pro" | "premium");
      window.location.href = url;
    } catch (error) {
      toast.error(errorMessage(error));
      setBusy(false);
    }
  };

  return (
    <Card className={cn("tilt-3d relative flex flex-col gap-5 p-6", featured && "ring-brand shadow-glow")} {...tilt}>
      {featured ? <Badge tone="solid" className="absolute -top-2.5 left-6">Most popular</Badge> : null}
      <div>
        <h2 className="text-lg font-semibold">{plan.name}</h2>
        <p className="mt-2 flex items-baseline gap-1">
          <span className={cn("tnum text-3xl font-semibold tracking-tight", featured && "text-brand")}>${Number(plan.price_usd).toFixed(0)}</span>
          <span className="text-sm text-muted-foreground">{paid ? "/ month" : "forever"}</span>
        </p>
      </div>
      <ul className="space-y-2 text-sm">
        <li className="flex gap-2">
          <Check className="mt-0.5 size-4 shrink-0 text-positive" aria-hidden />
          <span className="font-medium">{limitText(plan.zip_searches, plan.zip_searches === 1 ? "ZIP code search" : "ZIP code searches", plan.monthly)}</span>
        </li>
        <li className="flex gap-2">
          <Check className="mt-0.5 size-4 shrink-0 text-positive" aria-hidden />
          <span>{limitText(plan.property_reports, "property reports", plan.monthly)}</span>
        </li>
        {plan.features.map((feature) => (
          <li key={feature} className="flex gap-2">
            <Check className="mt-0.5 size-4 shrink-0 text-positive" aria-hidden />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
      <div className="mt-auto">
        {current ? (
          <Button variant="outline" className="w-full" disabled>
            Current plan
          </Button>
        ) : !user ? (
          <Button asChild className="w-full" variant={featured ? "default" : "outline"}>
            <Link href={`/login?mode=register&next=/pricing`}>{paid ? "Create account to upgrade" : "Create free account"}</Link>
          </Button>
        ) : paid ? (
          <Button className="w-full" variant={featured ? "default" : "outline"} onClick={upgrade} disabled={busy}>
            {busy ? "Opening checkout…" : `Upgrade to ${plan.name}`}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

function PricingContent() {
  const params = useSearchParams();
  const { user } = useSession();
  const client = useQueryClient();
  const plansQuery = useQuery({ queryKey: ["plans"], queryFn: api.plans, staleTime: 60_000 });
  const { data: account } = useAccount();
  const checkout = params.get("checkout");

  React.useEffect(() => {
    if (checkout === "success") {
      void client.invalidateQueries({ queryKey: ["account"] });
      void client.invalidateQueries({ queryKey: ["session"] });
    }
  }, [checkout, client]);

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-8 lg:px-6">
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight">Plans & pricing</h1>
        <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
          Every search analyses all active listings in a ZIP code as long-term rentals. Re-opening a ZIP code you already searched this period is
          free.
        </p>
      </div>

      {checkout === "success" ? <Alert tone="success" title="Thank you!">Your subscription is active. It can take a few seconds to show here.</Alert> : null}
      {checkout === "cancelled" ? <Alert tone="info">Checkout was cancelled — you have not been charged.</Alert> : null}

      {user && account && !account.unlimited ? (
        <Card className="space-y-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs text-muted-foreground">Your plan</p>
              <p className="text-lg font-semibold">{account.plan_name}</p>
            </div>
            {account.can_manage_billing ? (
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    window.location.href = (await api.billingPortal()).url;
                  } catch (error) {
                    toast.error(errorMessage(error));
                  }
                }}
              >
                Manage billing
              </Button>
            ) : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Meter label={account.monthly ? "ZIP code searches this month" : "ZIP code searches"} used={account.zip_searches_used} limit={account.zip_searches_limit} />
            <Meter label={account.monthly ? "Property reports this month" : "Property reports"} used={account.property_reports_used} limit={account.property_reports_limit} />
          </div>
          {account.searched_zips.length ? <p className="text-xs text-muted-foreground">Searched: {account.searched_zips.join(", ")}</p> : null}
        </Card>
      ) : null}

      {plansQuery.isLoading ? (
        <div className="grid gap-4 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-96" />
          ))}
        </div>
      ) : plansQuery.data ? (
        <div className="grid gap-4 md:grid-cols-3">
          {plansQuery.data.plans.map((plan) => (
            <PlanCard key={plan.key} plan={plan} current={!!user && account?.plan === plan.key && !account?.unlimited} billing={plansQuery.data.billing_enabled} featured={plan.key === "pro"} />
          ))}
        </div>
      ) : (
        <Alert tone="error">Plans could not be loaded.</Alert>
      )}

      <div className="grid gap-4 text-sm sm:grid-cols-2">
        <div>
          <h3 className="font-semibold">What counts as a ZIP code search?</h3>
          <p className="mt-1 text-muted-foreground">Each different ZIP code you search in a period. Changing filters, sorting or re-running a ZIP you already searched doesn&apos;t count.</p>
        </div>
        <div>
          <h3 className="font-semibold">What is a property report?</h3>
          <p className="mt-1 text-muted-foreground">A property-specific rent and value estimate with comparables, fetched when you open a property. Properties already unlocked stay free.</p>
        </div>
      </div>
    </div>
  );
}

export default function PricingPage() {
  return (
    <React.Suspense fallback={<div className="p-6"><Skeleton className="h-96 w-full" /></div>}>
      <PricingContent />
    </React.Suspense>
  );
}
