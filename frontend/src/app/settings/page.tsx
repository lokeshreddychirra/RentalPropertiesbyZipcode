"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleDashed, Lock, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Skeleton, Table, Td, Th } from "@/components/ui/card";
import { Field, Input, Label, NumberInput, Select, Switch, Textarea } from "@/components/ui/form";
import { api, errorMessage } from "@/lib/api";
import { useApp, useSession, useStatus } from "@/lib/store";
import type { AssumptionSection, ProviderUsage, ScoreWeights } from "@/lib/types";
import { relativeTime, shortDate } from "@/lib/utils";

const DEFAULT_FIELDS: { title: string; fields: { section: AssumptionSection; name: string; label: string; suffix?: string; prefix?: string }[] }[] = [
  {
    title: "Financing",
    fields: [
      { section: "financing", name: "down_payment_pct", label: "Down payment", suffix: "%" },
      { section: "financing", name: "interest_rate_pct", label: "Interest rate", suffix: "%" },
      { section: "financing", name: "loan_term_years", label: "Loan term", suffix: "yr" },
      { section: "acquisition", name: "closing_cost_pct", label: "Closing costs", suffix: "%" },
      { section: "acquisition", name: "reserve_months", label: "Cash reserves", suffix: "mo" },
    ],
  },
  {
    title: "Long-term rental",
    fields: [
      { section: "long_term", name: "vacancy_pct", label: "Vacancy", suffix: "%" },
      { section: "long_term", name: "management_pct", label: "Management", suffix: "%" },
      { section: "long_term", name: "maintenance_pct", label: "Maintenance", suffix: "%" },
      { section: "long_term", name: "capex_pct", label: "CapEx reserve", suffix: "%" },
    ],
  },
  {
    title: "Short-term rental",
    fields: [
      { section: "short_term", name: "management_pct", label: "Management", suffix: "%" },
      { section: "short_term", name: "platform_fee_pct", label: "Platform fee", suffix: "%" },
      { section: "short_term", name: "unavailable_nights", label: "Unavailable nights", suffix: "nts" },
      { section: "short_term", name: "utilities_monthly", label: "Utilities / mo", prefix: "$" },
    ],
  },
  {
    title: "Ownership & growth",
    fields: [
      { section: "fixed", name: "property_tax_rate_pct", label: "Tax rate (when estimating)", suffix: "%" },
      { section: "fixed", name: "insurance_rate_pct", label: "Insurance rate (when estimating)", suffix: "%" },
      { section: "forecast", name: "rent_growth_pct", label: "Rent growth / yr", suffix: "%" },
      { section: "forecast", name: "appreciation_pct", label: "Appreciation / yr", suffix: "%" },
      { section: "forecast", name: "expense_inflation_pct", label: "Expense inflation / yr", suffix: "%" },
      { section: "forecast", name: "selling_cost_pct", label: "Selling costs", suffix: "%" },
    ],
  },
];

function DefaultsCard() {
  const { defaults, setDefault, resetDefaults, hydrated } = useApp();
  const meta = useQuery({ queryKey: ["meta"], queryFn: api.meta, staleTime: Infinity });
  const { user } = useSession();
  const system = meta.data?.default_assumptions as Record<string, Record<string, number | null>> | undefined;
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Default assumptions</CardTitle>
          <CardDescription>
            Applied to every search, ranking and analysis. Leave a field empty to use the standard default shown in grey. {user ? "Saved to your account." : "Stored in this browser — sign in to keep them across devices."}
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={resetDefaults}>
          <RotateCcw /> Reset all
        </Button>
      </CardHeader>
      <CardContent>
        {!hydrated || !system ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
            {DEFAULT_FIELDS.map((group) => (
              <fieldset key={group.title} className="space-y-3">
                <legend className="mb-1 text-sm font-semibold">{group.title}</legend>
                {group.fields.map((field) => {
                  const current = (defaults[field.section] as Record<string, number | null> | undefined)?.[field.name] ?? null;
                  const id = `d-${field.section}-${field.name}`;
                  return (
                    <div key={id} className="grid grid-cols-[minmax(0,1fr)_6.5rem] items-center gap-2">
                      <Label htmlFor={id}>{field.label}</Label>
                      <NumberInput id={id} value={current} placeholder={String(system[field.section]?.[field.name] ?? "")} onValueChange={(v) => setDefault(field.section, field.name, v)} prefix={field.prefix} suffix={field.suffix} className="h-8 text-right" />
                    </div>
                  );
                })}
              </fieldset>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function WeightsCard() {
  const { weights, setWeights, hydrated } = useApp();
  const meta = useQuery({ queryKey: ["meta"], queryFn: api.meta, staleTime: Infinity });
  if (!meta.data || !hydrated) return <Skeleton className="h-64 w-full" />;
  const base = meta.data.default_weights as Record<string, number>;
  const current: Record<string, number> = { ...base, ...((weights ?? {}) as Record<string, number>) };
  const total = Object.values(current).reduce((sum, v) => sum + (v || 0), 0);
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Investment score weights</CardTitle>
          <CardDescription>
            The 0–100 score is a weighted average of seven components, each normalised on a fixed scale. Weights are relative — they are rescaled to total 100%. Properties with
            low data confidence are capped at 70, and insufficient data at 40, whatever the weights.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => setWeights(null)} disabled={!weights}>
          <RotateCcw /> Restore defaults
        </Button>
      </CardHeader>
      <CardContent>
        <div className="grid gap-x-8 gap-y-3 md:grid-cols-2">
          {Object.keys(base).map((key) => (
            <div key={key} className="grid grid-cols-[minmax(0,1fr)_5.5rem_3.5rem] items-center gap-2">
              <Label htmlFor={`w-${key}`}>{meta.data.weight_labels[key] ?? key}</Label>
              <NumberInput
                id={`w-${key}`}
                value={current[key]}
                min={0}
                max={100}
                className="h-8 text-right"
                onValueChange={(v) => {
                  if (v === null) return;
                  const next = { ...current, [key]: Math.min(Math.max(v, 0), 100) };
                  if (Object.values(next).reduce((s, x) => s + x, 0) <= 0) return toast.warning("At least one weight must be above zero.");
                  setWeights(next as ScoreWeights);
                }}
              />
              <span className="tnum text-right text-xs text-muted-foreground">{total > 0 ? ((current[key] / total) * 100).toFixed(0) : 0}%</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function DataSourcesCard() {
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
              Optional: <code className="rounded bg-card px-1">AIRDNA_API_KEY</code> for short-term rental estimates, <code className="rounded bg-card px-1">MAPBOX_ACCESS_TOKEN</code> for radius/county searches and{" "}
              <code className="rounded bg-card px-1">MAPBOX_PUBLIC_TOKEN</code> for the map, <code className="rounded bg-card px-1">ANTHROPIC_API_KEY</code> for AI analysis.
            </li>
            <li>Restart the services and set monthly budgets below. See docs/DATA_PROVIDERS.md for details and provider terms.</li>
          </ol>
        </div>
        <p className="text-xs text-muted-foreground">
          Cached data is reused for: listings {status.freshness.listing_cache_hours} h · rent estimates {status.freshness.rent_estimate_days} days · STR estimates {status.freshness.str_estimate_days} days · market
          statistics {status.freshness.market_stats_days} days. Premium estimates are requested for the top {status.limits.rent_avm_top_n} (rent) and {status.limits.str_estimate_top_n} (STR) candidates per search, or on
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

function UsageCard() {
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
              {user ? "Only administrators can change budgets." : <>Budgets can be changed by an administrator. <Link href="/login?next=/settings">Sign in</Link> — the first account created on a new installation is the administrator.</>}
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

function RegulationsCard() {
  const { user } = useSession();
  const client = useQueryClient();
  const admin = user?.role === "admin";
  const list = useQuery({ queryKey: ["regulations"], queryFn: api.regulations });
  const [form, setForm] = React.useState({ jurisdiction_type: "city", jurisdiction_key: "", status: "restricted", summary: "", max_nights_per_year: "", source_url: "", verified_at: new Date().toISOString().slice(0, 10) });
  return (
    <Card id="str-regulations" className="scroll-mt-20">
      <CardHeader>
        <CardTitle>Short-term rental regulation registry</CardTitle>
        <CardDescription>
          STR legality is only shown as permitted, restricted or prohibited when a rule has been recorded here with a source. Everything else is “Unknown / needs verification” —
          the app never infers legality from nearby listings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {list.data?.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Jurisdiction</Th>
                <Th>Status</Th>
                <Th>Summary</Th>
                <Th>Verified</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((rule) => (
                <tr key={rule.id}>
                  <Td className="font-medium">
                    {rule.jurisdiction_key} <span className="text-xs font-normal text-muted-foreground">({rule.jurisdiction_type})</span>
                  </Td>
                  <Td>
                    <Badge tone={rule.status === "permitted" ? "positive" : rule.status === "prohibited" ? "negative" : "warning"}>{rule.status}</Badge>
                  </Td>
                  <Td className="max-w-[360px] text-xs text-muted-foreground">
                    {rule.summary}
                    {rule.max_nights_per_year != null ? ` Night cap: ${rule.max_nights_per_year}/yr.` : ""}{" "}
                    {rule.source_url ? (
                      <a href={rule.source_url} target="_blank" rel="noopener noreferrer" className="underline">
                        Source
                      </a>
                    ) : null}
                  </Td>
                  <Td className="text-xs text-muted-foreground">{shortDate(rule.verified_at)}</Td>
                  <Td className="text-right">
                    <Button size="sm" variant="outline" disabled={!admin} aria-label={`Delete rule for ${rule.jurisdiction_key}`} onClick={async () => { await api.deleteRegulation(rule.id).catch((error) => toast.error(errorMessage(error))); await client.invalidateQueries({ queryKey: ["regulations"] }); }}>
                      <Trash2 />
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">No verified rules recorded yet. All live locations currently show “Unknown / needs verification”.</p>
        )}

        {admin ? (
          <form
            className="grid grid-cols-2 items-end gap-3 rounded-lg border p-4 md:grid-cols-6"
            onSubmit={async (event) => {
              event.preventDefault();
              try {
                await api.saveRegulation({ ...form, summary: form.summary || null, max_nights_per_year: form.max_nights_per_year ? Number(form.max_nights_per_year) : null });
                toast.success("Regulation recorded");
                setForm({ ...form, jurisdiction_key: "", summary: "", max_nights_per_year: "", source_url: "" });
                await client.invalidateQueries({ queryKey: ["regulations"] });
              } catch (error) {
                toast.error(errorMessage(error));
              }
            }}
          >
            <Field label="Level" htmlFor="r-type">
              <Select id="r-type" value={form.jurisdiction_type} onChange={(e) => setForm({ ...form, jurisdiction_type: e.target.value })}>
                <option value="zip">ZIP code</option>
                <option value="city">City</option>
                <option value="county">County</option>
                <option value="state">State</option>
              </Select>
            </Field>
            <Field label="Jurisdiction" htmlFor="r-key" hint="“Atlanta, GA”, “Fulton, GA”, “30303” or “GA”">
              <Input id="r-key" required value={form.jurisdiction_key} onChange={(e) => setForm({ ...form, jurisdiction_key: e.target.value })} />
            </Field>
            <Field label="Status" htmlFor="r-status">
              <Select id="r-status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                <option value="permitted">Permitted</option>
                <option value="restricted">Restricted</option>
                <option value="prohibited">Prohibited</option>
              </Select>
            </Field>
            <Field label="Night cap / yr" htmlFor="r-cap" hint="Optional">
              <Input id="r-cap" inputMode="numeric" value={form.max_nights_per_year} onChange={(e) => setForm({ ...form, max_nights_per_year: e.target.value.replace(/\D/g, "") })} />
            </Field>
            <Field label="Verified on" htmlFor="r-date">
              <Input id="r-date" type="date" required value={form.verified_at} onChange={(e) => setForm({ ...form, verified_at: e.target.value })} />
            </Field>
            <Field label="Official source URL" htmlFor="r-url" hint="Required">
              <Input id="r-url" type="url" required placeholder="https://…" value={form.source_url} onChange={(e) => setForm({ ...form, source_url: e.target.value })} />
            </Field>
            <Field label="Summary of the rule" htmlFor="r-summary" className="col-span-2 md:col-span-5">
              <Textarea id="r-summary" value={form.summary} maxLength={2000} onChange={(e) => setForm({ ...form, summary: e.target.value })} className="min-h-[40px]" />
            </Field>
            <Button type="submit">Record rule</Button>
          </form>
        ) : (
          <p className="text-xs text-muted-foreground">Administrators can record verified rules with a link to the official source.</p>
        )}
      </CardContent>
    </Card>
  );
}

function NotificationsCard() {
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

export default function SettingsPage() {
  const { user, loading } = useSession();
  if (loading) return null;
  if (user?.role !== "admin") {
    return (
      <div className="mx-auto max-w-[1440px] px-4 py-10 lg:px-6">
        <EmptyState
          icon={<Lock />}
          title="Settings are for administrators"
          action={
            user ? undefined : (
              <Button asChild>
                <Link href="/login?next=/settings">Sign in as administrator</Link>
              </Button>
            )
          }
        >
          Data sources, API usage, budgets and scoring defaults are managed by the site administrator.
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-[1440px] space-y-5 px-4 py-5 lg:px-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Your default assumptions, scoring, data sources and API budgets.</p>
      </div>
      <DefaultsCard />
      <WeightsCard />
      <NotificationsCard />
      <DataSourcesCard />
      <UsageCard />
      <RegulationsCard />
    </div>
  );
}
