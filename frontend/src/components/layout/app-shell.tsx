"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, Bell, Bookmark, Building2, CreditCard, GitCompareArrows, LayoutDashboard, LogOut, Map as MapIcon, Menu, Search, TrendingUp, User as UserIcon, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTrigger, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/overlays";
import { api } from "@/lib/api";
import { useAccount, useApp, useSession, useStatus } from "@/lib/store";
import { cn, relativeTime } from "@/lib/utils";

type Access = "everyone" | "user" | "admin";
const NAV: { href: string; label: string; icon: typeof Search; access: Access }[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, access: "everyone" },
  { href: "/map", label: "Investment Map", icon: MapIcon, access: "everyone" },
  { href: "/compare", label: "Property Comparison", icon: GitCompareArrows, access: "everyone" },
  { href: "/saved", label: "Saved Properties", icon: Bookmark, access: "user" },
  { href: "/market", label: "Market Analytics", icon: BarChart3, access: "everyone" },
  { href: "/pricing", label: "Plans & Pricing", icon: CreditCard, access: "everyone" },
  { href: "/admin/users", label: "Admin Portal", icon: Users, access: "admin" },
];

function useAccess(): (access: Access) => boolean {
  const { user } = useSession();
  return (access) => access === "everyone" || (access === "user" && !!user) || (access === "admin" && user?.role === "admin");
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5 px-1" aria-label="PropertyYield AI home">
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <TrendingUp className="size-4" aria-hidden />
      </span>
      <span className="text-[15px] font-semibold tracking-tight">
        PropertyYield <span className="text-positive">AI</span>
      </span>
    </Link>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { compare } = useApp();
  const allowed = useAccess();
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV.filter((item) => allowed(item.access)).map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            <span className="flex-1">{label}</span>
            {href === "/compare" && compare.length > 0 ? <Badge tone="solid">{compare.length}</Badge> : null}
          </Link>
        );
      })}
    </nav>
  );
}

function Notifications() {
  const { user } = useSession();
  const client = useQueryClient();
  const { data } = useQuery({ queryKey: ["notifications", user?.id], queryFn: api.notifications, enabled: !!user, refetchInterval: 120_000 });
  if (!user) return null;
  const unread = data?.unread ?? 0;
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open && unread > 0) api.markAllRead().then(() => client.invalidateQueries({ queryKey: ["notifications"] }));
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`} className="relative">
          <Bell />
          {unread > 0 ? <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-negative" aria-hidden /> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>Alerts</DropdownMenuLabel>
        {data?.items.length ? (
          <div className="max-h-96 overflow-y-auto">
            {data.items.slice(0, 15).map((item) => (
              <DropdownMenuItem key={item.id} asChild className="items-start">
                <Link href={item.property_id ? `/properties/${item.property_id}` : "/saved"}>
                  <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", item.read_at ? "bg-transparent" : "bg-negative")} aria-hidden />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{item.title}</span>
                    <span className="block text-xs text-muted-foreground">{item.body}</span>
                    <span className="block text-[11px] text-muted-foreground">{relativeTime(item.created_at)}</span>
                  </span>
                </Link>
              </DropdownMenuItem>
            ))}
          </div>
        ) : (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">No alerts yet. Enable alerts on a saved search to be notified about new matches and price drops.</p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "Free · 0 of 1 ZIP searches" — links to the pricing page. Hidden for administrators and guests. */
function PlanChip() {
  const { data: account } = useAccount();
  if (!account || account.unlimited || !account.quotas_apply) return null;
  const limit = account.zip_searches_limit;
  const left = limit == null ? null : Math.max(limit - account.zip_searches_used, 0);
  return (
    <Link
      href="/pricing"
      className={cn(
        "hidden items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors hover:border-foreground/30 sm:inline-flex",
        left === 0 ? "border-negative/40 text-negative" : "text-muted-foreground",
      )}
    >
      <span className="font-semibold text-foreground">{account.plan_name}</span>
      <span aria-hidden>·</span>
      {left == null ? "Unlimited ZIP searches" : `${left} ZIP search${left === 1 ? "" : "es"} left${account.monthly ? " this month" : ""}`}
    </Link>
  );
}

function UserMenu() {
  const { user, loading, refresh } = useSession();
  const router = useRouter();
  const client = useQueryClient();
  if (loading) return <div className="size-9" />;
  if (!user) {
    return (
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link href="/login">Sign in</Link>
        </Button>
        <Button asChild size="sm">
          <Link href="/login?mode=register">Create free account</Link>
        </Button>
      </div>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Account menu">
          <UserIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          <span className="block truncate text-sm text-foreground">{user.name || user.email}</span>
          {user.role === "admin" ? <span className="text-[11px]">Administrator</span> : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/saved">
            <Bookmark /> Saved properties
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/pricing">
            <CreditCard /> Plan & billing
          </Link>
        </DropdownMenuItem>
        {user.role === "admin" ? (
          <>
            <DropdownMenuItem asChild>
              <Link href="/admin/users">
                <Users /> Admin portal
              </Link>
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={async () => {
            await api.logout();
            client.removeQueries({ queryKey: ["favorites"] });
            await refresh();
            router.refresh();
          }}
        >
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function DemoBanner() {
  const { data } = useStatus();
  const { user } = useSession();
  if (!data || data.data_mode !== "demo") return null;
  return (
    <div role="status" className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 border-b border-[#d6ccfb] bg-[#f5f3ff] px-4 py-1.5 text-center text-xs text-[#4c1d95]">
      <Badge tone="demo" className="font-semibold uppercase tracking-wide">
        Demo data
      </Badge>
      <span>Every property and rent shown is synthetic sample data — not a real listing.</span>
      {user?.role === "admin" ? (
        <Link href="/admin/users#data-sources" className="font-medium underline underline-offset-2">
          Connect live data
        </Link>
      ) : null}
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const bare = pathname.startsWith("/login");

  if (bare) {
    return (
      <div className="min-h-screen">
        <DemoBanner />
        {children}
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:text-primary-foreground">
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col gap-6 border-r bg-card px-3 py-4 lg:flex">
        <Brand />
        <NavLinks />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <DemoBanner />
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-card/95 px-4 backdrop-blur lg:px-6">
          <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation">
                <Menu />
              </Button>
            </DialogTrigger>
            <DialogContent side="left" title="PropertyYield AI">
              <NavLinks onNavigate={() => setMobileOpen(false)} />
            </DialogContent>
          </Dialog>
          <div className="lg:hidden">
            <Brand />
          </div>
          <div className="hidden items-center gap-2 text-sm text-muted-foreground lg:flex">
            <Building2 className="size-4" aria-hidden />
            Residential investment analysis · United States
          </div>
          <div className="ml-auto flex items-center gap-2">
            <PlanChip />
            <Notifications />
            <UserMenu />
          </div>
        </header>
        <main id="main" className="flex-1">
          {children}
        </main>
        <footer className="border-t px-4 py-4 text-center text-[11px] leading-relaxed text-muted-foreground lg:px-6">
          Estimates and projections are for research only and are not financial, legal or tax advice. Verify listings, rents and taxes independently before
          investing.
        </footer>
      </div>
    </div>
  );
}
