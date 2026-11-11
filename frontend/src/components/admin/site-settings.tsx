"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleDashed } from "@/components/ui/icons";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton, Table, Td, Th } from "@/components/ui/card";
import { NumberInput, Switch } from "@/components/ui/form";
import { api, errorMessage } from "@/lib/api";
import { useSession, useStatus } from "@/lib/store";
import type { ProviderUsage } from "@/lib/types";
import { relativeTime } from "@/lib/utils";

export function DataSourcesCard() {
  const { data: status } = useStatus();
  if (!status) return <Skeleton className="h-64 w-full" />;
  return (
    <Card id="data-sources" className="scroll-mt-20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Data sources <Badge tone={status.data_mode === "live" ? "positive" : "demo"}>{status.data_mode === "live" ? "Live" : "Demo mode"}</Badge>
        </CardTitle>
        <CardDescription>API keys are configured on the server through environment variables or your secret manager — never in the browser.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status.demo_notice ? <Alert tone="demo">{status.demo_notice}</Alert> : null}
        <ul className="divide-y rounded-lg border">
          {status.providers.map((provider) => (
            <li key={provider.key} className="flex flex-wrap items-start gap-3 px-4 py-3">
              {provider.configured ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-positive" aria-hidden /> : <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {provider.name} <span className="font-normal text-muted-foreground">— {provider.purpose}</span>
                </p>
                <p className="text-xs text-muted-foreground">{provider.configured ? (provider.attribution ?? "Connected") : provider.note}</p>
              </div>
              <Badge tone={provider.configured ? "positive" : "outline"}>{provider.configured ? "Connected" : "Not configured"}</Badge>
            </li>
          ))}
        </ul>
        <div className="rounded-lg bg-muted/50 p-4 text-sm leading-relaxed">
          <p className="font-semibold">Activating live data</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>
              Create a RentCast API key and set <code className="rounded bg-card px-1">RENTCAST_API_KEY</code> on the API and worker services (keep <code className="rounded bg-card px-1">DATA_MODE=auto</code> or set it to <code className="rounded bg-card px-1">live</code>).
            </li>
            <li>
              Optional: <code className="rounded bg-card px-1">MAPBOX_ACCESS_TOKEN</code> for radius/county searches and{" "}
              <code className="rounded bg-card px-1">MAPBOX_PUBLIC_TOKEN</code> for the map, <code className="rounded bg-card px-1">ANTHROPIC_API_KEY</code> for AI analysis.
            </li>
            <li>Restart the services and set monthly budgets below. See docs/DATA_PROVIDERS.md for details and provider terms.</li>
          </ol>
        </div>
        <p className="text-xs text-muted-foreground">
          Cached data is reused for: listings {status.freshness.listing_cache_hours} h · rent estimates {status.freshness.rent_estimate_days} days · market
          statistics {status.freshness.market_stats_days} days. Premium estimates are requested for the top {status.limits.rent_avm_top_n} candidates per search, or on
          demand from a property&apos;s analysis page.
        </p>
      </CardContent>
    </Card>
  );
}

function BudgetRow({ provider, admin }: { provider: ProviderUsage; admin: boolean }) {
  const client = useQueryClient();
  const [requests, setRequests] = React.useState<number | null>(provider.monthly_request_limit ?? null);
  const [cost, setCost] = React.useState<number | null>(provider.monthly_cost_limit_usd ?? null);
  const [unit, setUnit] = React.useState<number | null>(provider.cost_per_request_usd);
  const dirty = requests !== (provider.monthly_request_limit ?? null) || cost !== (provider.monthly_cost_limit_usd ?? null) || unit !== provider.cost_per_request_usd;
  const save = async (body: Record<string, unknown>) => {
    try {
      await api.updateBudget(provider.key, body);
      toast.success(`${provider.name} budget updated`);
      await client.invalidateQueries({ queryKey: ["usage"] });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };
  const used = provider.request_budget_used_pct ?? 0;
  return (
    <tr>
      <Td className="font-medium">
        {provider.name}
        <span className="block text-[11px] font-normal text-muted-foreground">{provider.kind}</span>
      </Td>
      <Td className="tnum text-right">
        {provider.requests_this_month.toLocaleString()}
        {provider.errors_this_month ? <span className="block text-[11px] text-negative">{provider.errors_this_month} errors</span> : null}
      </Td>
      <Td className="tnum text-right">${provider.estimated_cost_this_month_usd.toFixed(2)}</Td>
      <Td className="min-w-[140px]">
        {provider.monthly_request_limit ? (
          <div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className={`h-full rounded-full ${used >= 100 ? "bg-negative" : used >= 80 ? "bg-caution" : "bg-positive"}`} style={{ width: `${Math.min(used, 100)}%` }} />
            </div>
            <span className="tnum text-[11px] text-muted-foreground">{used}% of requests{provider.cost_budget_used_pct != null ? ` · ${provider.cost_budget_used_pct}% of cost` : ""}</span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">No request limit</span>
        )}
      </Td>
      <Td>
        <NumberInput aria-label={`${provider.name} monthly request limit`} value={requests} onValueChange={(v) => setRequests(v === null ? null : Math.round(v))} disabled={!admin} placeholder="No limit" className="h-8 w-28 text-right" />
      </Td>
      <Td>
        <NumberInput aria-label={`${provider.name} monthly cost limit`} value={cost} onValueChange={setCost} disabled={!admin} prefix="$" placeholder="No limit" className="h-8 w-28 text-right" />
      </Td>
      <Td>
        <NumberInput aria-label={`${provider.name} estimated cost per request`} value={unit} onValueChange={setUnit} disabled={!admin} prefix="$" className="h-8 w-24 text-right" />
      </Td>
      <Td>
        <Switch checked={provider.enabled} disabled={!admin} aria-label={`${provider.name} enabled`} onCheckedChange={(checked) => save({ enabled: checked })} />
      </Td>
      <Td className="text-right">
        <Button size="sm" variant="outline" disabled={!admin || !dirty} onClick={() => save({ monthly_request_limit: requests, monthly_cost_limit_usd: cost, ...(unit !== null ? { cost_per_request_usd: unit } : {}) })}>
          Save
        </Button>
      </Td>
    </tr>
  );
}

export function UsageCard() {
  const { user } = useSession();
  const usage = useQuery({ queryKey: ["usage"], queryFn: api.usage, refetchInterval: 60_000 });
  const admin = user?.role === "admin";
  return (
    <Card id="usage" className="scroll-mt-20">
      <CardHeader>
        <CardTitle>API usage &amp; budgets</CardTitle>
        <CardDescription>
          Month to date ({usage.data?.month ?? "…"}). When a budget is reached, searches return partial results and say so — they never stop silently. {usage.data?.note}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-0 pb-0">
        {!admin ? (
          <div className="px-5">
            <Alert tone="info">
              {user ? "Only administrators can change budgets." : <>Budgets can be changed by an administrator. <Link href="/login?next=/admin/users">Sign in</Link> — the first account created on a new installation is the administrator.</>}
            </Alert>
          </div>
        ) : null}
        {usage.isLoading ? (
          <div className="px-5 pb-5"><Skeleton className="h-40 w-full" /></div>
        ) : usage.data ? (
          <>
            <Table>
              <thead>
                <tr>
                  <Th className="pl-5">Provider</Th>
                  <Th className="text-right">Requests</Th>
                  <Th className="text-right">Est. cost</Th>
                  <Th>Budget used</Th>
                  <Th>Request limit / mo</Th>
                  <Th>Cost limit / mo</Th>
                  <Th>Cost / request</Th>
                  <Th>Enabled</Th>
                  <Th className="pr-5" />
                </tr>
              </thead>
              <tbody>
                {usage.data.providers.map((provider) => (
                  <BudgetRow key={`${provider.key}-${provider.monthly_request_limit}-${provider.monthly_cost_limit_usd}-${provider.cost_per_request_usd}`} provider={provider} admin={admin} />
                ))}
              </tbody>
            </Table>
            {usage.data.recent_errors.length ? (
              <details className="border-t px-5 py-3">
                <summary className="cursor-pointer text-sm font-medium">Recent provider errors ({usage.data.recent_errors.length})</summary>
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {usage.data.recent_errors.map((error, i) => (
                    <li key={i}>
                      <span className="tnum">{relativeTime(error.created_at)}</span> · {error.provider} · {error.endpoint} · {error.error ?? `HTTP ${error.status_code}`}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function NotificationsCard() {
  const { user } = useSession();
  const client = useQueryClient();
  const prefs = useQuery({ queryKey: ["preferences", user?.id], queryFn: api.preferences, enabled: !!user });
  if (!user) return null;
  const email = prefs.data?.notification_settings?.email_alerts ?? false;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>Alerts come from saved searches (Saved Properties → Searches). In-app alerts appear under the bell icon.</CardDescription>
      </CardHeader>
      <CardContent>
        <label className="flex items-center justify-between gap-4 rounded-lg border p-3">
          <span>
            <span className="block text-sm font-medium">Email alerts</span>
            <span className="block text-xs text-muted-foreground">Send a digest to {user.email} when a saved search has new alerts. Requires SMTP to be configured on the server.</span>
          </span>
          <Switch
            checked={email}
            aria-label="Email alerts"
            onCheckedChange={async (checked) => {
              try {
                await api.savePreferences({ notification_settings: { email_alerts: checked, in_app_alerts: true } });
                await client.invalidateQueries({ queryKey: ["preferences"] });
              } catch (error) {
                toast.error(errorMessage(error));
              }
            }}
          />
        </label>
      </CardContent>
    </Card>
  );
}

