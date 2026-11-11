"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Database, DollarSign, Gauge, Lock, Search, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Skeleton, Table, Td, Th } from "@/components/ui/card";
import { Field, Input, NumberInput, Select } from "@/components/ui/form";
import { api, errorMessage } from "@/lib/api";
import { useSession, useStatus } from "@/lib/store";
import type { AdminUser, AdminUsers, PlanInfo } from "@/lib/types";
import { cn, relativeTime, shortDate } from "@/lib/utils";

function Stat({ icon, label, value, sub, href, tone }: { icon: React.ReactNode; label: string; value: React.ReactNode; sub: React.ReactNode; href?: string; tone?: string }) {
  const body = (
    <Card className={cn("flex h-full items-start gap-3 p-4", href && "transition-shadow hover:shadow-md")}>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">{icon}</span>
      <span className="min-w-0">
        <span className="block text-xs text-muted-foreground">{label}</span>
        <span className={cn("tnum block truncate text-lg font-semibold leading-tight", tone)}>{value}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{sub}</span>
      </span>
    </Card>
  );
  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

/** Site overview for the administrator: data source, RentCast usage, accounts and revenue. */
function AdminStats({ users }: { users: AdminUsers | undefined }) {
  const { data: status } = useStatus();
  const usage = useQuery({ queryKey: ["usage"], queryFn: api.usage, staleTime: 60_000 });
  const rentcast = usage.data?.providers.find((p) => p.key === "rentcast");
  const live = status?.data_mode === "live";
  const paid = users ? (users.by_plan.pro ?? 0) + (users.by_plan.premium ?? 0) : 0;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <Stat
        icon={<Database />}
        label="Data source"
        value={status ? (live ? "Live listings" : "Demo dataset") : "—"}
        tone={live ? "text-positive" : "text-[#5b21b6]"}
        sub={live ? "RentCast connected" : "Sample properties — not real listings"}
        href="/settings#data-sources"
      />
      <Stat
        icon={<Gauge />}
        label="RentCast requests this month"
        value={rentcast ? `${rentcast.requests_this_month.toLocaleString()}${rentcast.monthly_request_limit ? ` of ${rentcast.monthly_request_limit}` : ""}` : "—"}
        tone={rentcast?.monthly_request_limit && rentcast.requests_this_month >= rentcast.monthly_request_limit ? "text-negative" : undefined}
        sub={rentcast ? `Est. $${rentcast.estimated_cost_this_month_usd.toFixed(2)} · change the limit in Settings` : "Loading…"}
        href="/settings#usage"
      />
      <Stat
        icon={<Users />}
        label="Accounts"
        value={users ? users.total.toLocaleString() : "—"}
        sub={users ? `${paid} paying · ${users.by_plan.free ?? 0} free · ${users.new_users_this_month} new this month` : "Loading…"}
      />
      <Stat
        icon={<Activity />}
        label="Searches this month"
        value={users ? users.zip_searches_this_month.toLocaleString() : "—"}
        sub={users ? `${users.property_reports_this_month} property reports · ${users.active_users_this_month} active users` : "Loading…"}
      />
      <Stat
        icon={<DollarSign />}
        label="Monthly revenue (list price)"
        value={users ? `$${Number(users.monthly_revenue_usd).toFixed(0)}` : "—"}
        sub={users ? `${users.by_plan.pro ?? 0} Pro · ${users.by_plan.premium ?? 0} Premium` : "Loading…"}
      />
    </div>
  );
}

const PLAN_TONE: Record<string, string> = { free: "bg-muted-foreground/40", pro: "bg-primary", premium: "bg-positive" };

/** Users, usage and revenue per plan, plus the most active users. */
function PlanBreakdown({ data }: { data: AdminUsers }) {
  const total = Math.max(data.total, 1);
  const top = [...data.users].filter((u) => u.zip_searches_used > 0).sort((a, b) => b.zip_searches_used - a.zip_searches_used || b.property_reports_used - a.property_reports_used).slice(0, 5);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Users by plan</CardTitle>
          <CardDescription>ZIP searches and reports count each plan&apos;s own allowance period — lifetime for Free, this month for Pro and Premium.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex h-3 overflow-hidden rounded-full bg-muted" aria-hidden>
            {data.plan_summary.map((row) => (
              <div key={row.plan} className={PLAN_TONE[row.plan] ?? "bg-primary"} style={{ width: `${(row.users / total) * 100}%` }} />
            ))}
          </div>
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <Th>Plan</Th>
                  <Th className="text-right">Users</Th>
                  <Th className="text-right">Share</Th>
                  <Th className="text-right">ZIP searches</Th>
                  <Th className="text-right">Avg / user</Th>
                  <Th className="text-right">Reports</Th>
                  <Th className="text-right">Revenue / mo</Th>
                </tr>
              </thead>
              <tbody>
                {data.plan_summary.map((row) => (
                  <tr key={row.plan}>
                    <Td className="font-medium">
                      <span className="inline-flex items-center gap-2">
                        <span className={cn("size-2.5 rounded-full", PLAN_TONE[row.plan] ?? "bg-primary")} aria-hidden />
                        {row.name}
                      </span>
                    </Td>
                    <Td className="tnum text-right">{row.users}</Td>
                    <Td className="tnum text-right">{Math.round((row.users / total) * 100)}%</Td>
                    <Td className="tnum text-right">{row.zip_searches}</Td>
                    <Td className="tnum text-right">{row.users ? (row.zip_searches / row.users).toFixed(1) : "—"}</Td>
                    <Td className="tnum text-right">{row.property_reports}</Td>
                    <Td className="tnum text-right">${Number(row.revenue_usd).toFixed(0)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Most active users</CardTitle>
          <CardDescription>By ZIP codes searched in their current period.</CardDescription>
        </CardHeader>
        <CardContent>
          {top.length ? (
            <ol className="space-y-2.5">
              {top.map((u, i) => (
                <li key={u.id} className="flex items-center gap-3 text-sm">
                  <span className="tnum w-4 text-xs text-muted-foreground">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{u.email}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{u.searched_zips.join(", ")}</span>
                  </span>
                  <Badge tone="outline" className="capitalize">{u.plan}</Badge>
                  <span className="tnum w-14 text-right text-xs">
                    {u.zip_searches_used} ZIP{u.zip_searches_used === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">No searches yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

type PlanDraft = { price_usd: number | null; zip_searches: number | null; property_reports: number | null; zips_per_search: number | null };

/** Edit each plan's price and allowances. Empty search/report fields mean unlimited. */
function PlanEditor({ plan }: { plan: PlanInfo }) {
  const client = useQueryClient();
  const initial = React.useMemo<PlanDraft>(
    () => ({ price_usd: Number(plan.price_usd), zip_searches: plan.zip_searches ?? null, property_reports: plan.property_reports ?? null, zips_per_search: plan.zips_per_search }),
    [plan],
  );
  const [draft, setDraft] = React.useState<PlanDraft>(initial);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => setDraft(initial), [initial]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const set = (key: keyof PlanDraft, value: number | null) => setDraft((d) => ({ ...d, [key]: value === null ? null : Math.max(0, Math.round(value * 100) / 100) }));
  const period = plan.monthly ? "per month" : "lifetime";

  const save = async () => {
    setBusy(true);
    try {
      await api.updatePlan(plan.key, {
        price_usd: draft.price_usd ?? 0,
        zip_searches: draft.zip_searches === null ? null : Math.round(draft.zip_searches),
        property_reports: draft.property_reports === null ? null : Math.round(draft.property_reports),
        zips_per_search: Math.max(1, Math.round(draft.zips_per_search ?? 1)),
      });
      toast.success(`${plan.name} plan updated`);
      await Promise.all([client.invalidateQueries({ queryKey: ["admin-plans"] }), client.invalidateQueries({ queryKey: ["plans"] }), client.invalidateQueries({ queryKey: ["account"] })]);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{plan.name}</h3>
        <Badge tone="outline">{plan.monthly ? "Resets monthly" : "Lifetime allowance"}</Badge>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Price / month" htmlFor={`p-${plan.key}-price`}>
          <NumberInput id={`p-${plan.key}-price`} prefix="$" value={draft.price_usd} onValueChange={(v) => set("price_usd", v)} min={0} disabled={plan.key === "free"} />
        </Field>
        <Field label="ZIPs per search" htmlFor={`p-${plan.key}-zps`}>
          <NumberInput id={`p-${plan.key}-zps`} value={draft.zips_per_search} onValueChange={(v) => set("zips_per_search", v)} min={1} max={25} />
        </Field>
        <Field label={`ZIP searches (${period})`} htmlFor={`p-${plan.key}-zips`} hint="Empty = unlimited">
          <NumberInput id={`p-${plan.key}-zips`} placeholder="Unlimited" value={draft.zip_searches} onValueChange={(v) => set("zip_searches", v)} min={0} />
        </Field>
        <Field label={`Property reports (${period})`} htmlFor={`p-${plan.key}-reports`} hint="Empty = unlimited">
          <NumberInput id={`p-${plan.key}-reports`} placeholder="Unlimited" value={draft.property_reports} onValueChange={(v) => set("property_reports", v)} min={0} />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        {dirty ? (
          <Button variant="ghost" size="sm" onClick={() => setDraft(initial)}>
            Undo
          </Button>
        ) : null}
        <Button size="sm" onClick={save} disabled={!dirty || busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

function UserRow({ user, me }: { user: AdminUser; me: string | undefined }) {
  const client = useQueryClient();
  const [busy, setBusy] = React.useState(false);
  const update = async (body: Parameters<typeof api.updateUser>[1], done: string) => {
    setBusy(true);
    try {
      await api.updateUser(user.id, body);
      toast.success(done);
      await client.invalidateQueries({ queryKey: ["admin-users"] });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <tr className={user.is_active ? "hover:bg-muted/40" : "opacity-60"}>
      <Td className="max-w-[240px]">
        <span className="block truncate font-medium">{user.email}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {user.name || "—"} {user.role === "admin" ? <Badge tone="solid" className="ml-1">Admin</Badge> : null}
          {!user.is_active ? <Badge tone="outline" className="ml-1">Disabled</Badge> : null}
        </span>
      </Td>
      <Td>
        <Select aria-label={`Plan for ${user.email}`} value={user.plan} disabled={busy} onChange={(e) => update({ plan: e.target.value }, `${user.email} moved to ${e.target.value}`)} className="w-28">
          <option value="free">Free</option>
          <option value="pro">Pro</option>
          <option value="premium">Premium</option>
        </Select>
        <span className="mt-0.5 block text-[11px] text-muted-foreground">{user.billed_online ? `Stripe · ${user.plan_status ?? ""}` : user.plan_status === "manual" ? "Set by admin" : ""}</span>
      </Td>
      <Td className="tnum text-right">
        {user.zip_searches_used}
        {user.searched_zips.length ? <span className="block max-w-[140px] truncate text-[11px] text-muted-foreground" title={user.searched_zips.join(", ")}>{user.searched_zips.join(", ")}</span> : null}
      </Td>
      <Td className="tnum text-right">{user.property_reports_used}</Td>
      <Td className="tnum text-right">
        {user.saved_properties} / {user.saved_searches}
      </Td>
      <Td className="whitespace-nowrap text-xs">{shortDate(user.created_at)}</Td>
      <Td className="whitespace-nowrap text-xs">
        {user.last_login_at ? relativeTime(user.last_login_at) : "—"}
        <span className="block text-[11px] text-muted-foreground">{user.login_count} sign-in{user.login_count === 1 ? "" : "s"}</span>
      </Td>
      <Td className="whitespace-nowrap text-right">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => update({ reset_usage: true }, `Usage reset for ${user.email}`)}>
          Reset usage
        </Button>
        {user.id !== me ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => update({ is_active: !user.is_active }, user.is_active ? "Account disabled" : "Account enabled")}>
            {user.is_active ? "Disable" : "Enable"}
          </Button>
        ) : null}
      </Td>
    </tr>
  );
}

export default function AdminUsersPage() {
  const { user, loading } = useSession();
  const isAdmin = user?.role === "admin";
  const [query, setQuery] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [planFilter, setPlanFilter] = React.useState("all");
  const [sortBy, setSortBy] = React.useState<"joined" | "searches" | "last_login">("joined");
  const plansQuery = useQuery({ queryKey: ["admin-plans"], queryFn: api.adminPlans, enabled: isAdmin });
  const usersQuery = useQuery({ queryKey: ["admin-users", search], queryFn: () => api.adminUsers(search), enabled: isAdmin });

  if (loading) return null;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-[1440px] px-4 py-10 lg:px-6">
        <EmptyState icon={<Lock />} title="Administrators only" action={user ? undefined : <Button asChild><Link href="/login?next=/admin/users">Sign in as administrator</Link></Button>}>
          User management and plan settings are available to the site administrator.
        </EmptyState>
      </div>
    );
  }

  const data = usersQuery.data;
  const visibleUsers = (data?.users ?? [])
    .filter((u) => planFilter === "all" || u.plan === planFilter)
    .sort((a, b) =>
      sortBy === "searches"
        ? b.zip_searches_used - a.zip_searches_used
        : sortBy === "last_login"
          ? (b.last_login_at ?? "").localeCompare(a.last_login_at ?? "")
          : b.created_at.localeCompare(a.created_at),
    );
  return (
    <div className="mx-auto max-w-[1440px] space-y-5 px-4 py-5 lg:px-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Admin portal</h1>
        <p className="text-sm text-muted-foreground">Site usage, plan allowances and every user account.</p>
      </div>

      <AdminStats users={data} />
      {data ? <PlanBreakdown data={data} /> : null}

      <Card>
        <CardHeader>
          <CardTitle>Plan allowances</CardTitle>
          <CardDescription>
            Changes apply immediately to everyone on the plan. The price here is what the pricing page shows — the amount actually charged comes from the matching Stripe
            price. Each new ZIP search costs about 2 RentCast requests and each property report about 1.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {plansQuery.data ? (
            <div className="grid gap-4 lg:grid-cols-3">
              {plansQuery.data.map((plan) => (
                <PlanEditor key={plan.key} plan={plan} />
              ))}
            </div>
          ) : (
            <Skeleton className="h-56 w-full" />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Users</CardTitle>
          <CardDescription>
            {data
              ? `${data.total} account${data.total === 1 ? "" : "s"} · ${Object.entries(data.by_plan).map(([plan, n]) => `${n} ${plan}`).join(" · ")} · about $${Number(data.monthly_revenue_usd).toFixed(0)}/month at list price`
              : "Loading…"}
            . Passwords are stored as one-way hashes and can never be displayed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <form
            className="flex flex-wrap gap-2 [&>input]:max-w-xs"
            onSubmit={(event) => {
              event.preventDefault();
              setSearch(query.trim());
            }}
          >
            <Input placeholder="Search email or name" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search users" />
            <Button type="submit" variant="outline">
              <Search /> Search
            </Button>
            <Select aria-label="Filter by plan" value={planFilter} onChange={(e) => setPlanFilter(e.target.value)} className="w-32">
              <option value="all">All plans</option>
              <option value="free">Free</option>
              <option value="pro">Pro</option>
              <option value="premium">Premium</option>
            </Select>
            <Select aria-label="Sort users" value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)} className="w-40">
              <option value="joined">Newest first</option>
              <option value="searches">Most searches</option>
              <option value="last_login">Last sign-in</option>
            </Select>
          </form>
          {usersQuery.isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : visibleUsers.length ? (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <thead>
                  <tr>
                    <Th>User</Th>
                    <Th>Plan</Th>
                    <Th className="text-right">ZIP searches</Th>
                    <Th className="text-right">Reports</Th>
                    <Th className="text-right">Saved props / searches</Th>
                    <Th>Joined</Th>
                    <Th>Last sign-in</Th>
                    <Th className="text-right">
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {visibleUsers.map((row) => (
                    <UserRow key={row.id} user={row} me={user?.id} />
                  ))}
                </tbody>
              </Table>
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">No users found.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
