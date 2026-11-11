"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Skeleton, Table, Td, Th } from "@/components/ui/card";
import { Field, Input, NumberInput, Select } from "@/components/ui/form";
import { api, errorMessage } from "@/lib/api";
import { useSession } from "@/lib/store";
import type { AdminUser, PlanInfo } from "@/lib/types";
import { relativeTime, shortDate } from "@/lib/utils";

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
  return (
    <div className="mx-auto max-w-[1440px] space-y-5 px-4 py-5 lg:px-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Users & plans</h1>
        <p className="text-sm text-muted-foreground">Set what each plan includes, see every account and change plans by hand.</p>
      </div>

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
            className="flex max-w-md gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setSearch(query.trim());
            }}
          >
            <Input placeholder="Search email or name" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search users" />
            <Button type="submit" variant="outline">
              <Search /> Search
            </Button>
          </form>
          {usersQuery.isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : data?.users.length ? (
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
                  {data.users.map((row) => (
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
