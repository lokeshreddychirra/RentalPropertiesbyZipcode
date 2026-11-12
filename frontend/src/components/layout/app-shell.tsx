"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Bookmark, Building2, CreditCard, GitCompareArrows, LayoutDashboard, LogOut, Menu, Moon, Search, Sun, TrendingUp, User as UserIcon, Users } from "@/components/ui/icons";
import { AppRuntime } from "@/components/layout/app-runtime";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Dialog, DialogContent, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/overlays";
import { api } from "@/lib/api";
import { useAccount, useApp, useSession, useStatus } from "@/lib/store";
import { cn, relativeTime } from "@/lib/utils";

type Access = "everyone" | "user" | "admin";
const NAV: { href: string; label: string; icon: typeof Search; access: Access }[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, access: "everyone" },
  { href: "/compare", label: "Property Comparison", icon: GitCompareArrows, access: "everyone" },
  { href: "/saved", label: "Saved Properties", icon: Bookmark, access: "user" },
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
      <span className="btn-brand flex size-9 items-center justify-center rounded-xl">
        <TrendingUp className="size-5" aria-hidden />
      </span>
      <span className="body-4 whitespace-nowrap tracking-tight">
        PropertyYield <span className="text-brand">AI</span>
      </span>
    </Link>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { compare } = useApp();
  const allowed = useAccess();
  return (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {NAV.filter((item) => allowed(item.access)).map(({ href, label, icon: Icon }, index) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            style={onNavigate ? { animationDelay: `${Math.min(index * 60, 400)}ms` } : undefined}
            className={cn(
              "title-4 group/nav relative flex items-center gap-3 rounded-xl px-3 py-2 transition-[color,background-color,box-shadow]",
              active ? "bg-primary/15 text-foreground shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.3)]" : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
              onNavigate && "nav-enter",
            )}
          >
            <Icon className={cn("size-5 shrink-0 transition-colors", active ? "text-primary" : "group-hover/nav:text-foreground")} aria-hidden />
            <span className="flex-1">{label}</span>
            {active ? <span className="size-1.5 rounded-full bg-[var(--brand-b)] shadow-[0_0_10px_var(--brand-b)]" aria-hidden /> : null}
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
                    <span className="caption-5 block text-muted-foreground">{relativeTime(item.created_at)}</span>
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
        <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
          <Link href="/login">Sign in</Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href="/login?mode=register">
            <span className="sm:hidden">Sign up</span>
            <span className="hidden sm:inline">Create free account</span>
          </Link>
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
          {user.role === "admin" ? <span className="caption-5">Administrator</span> : null}
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
    <div role="status" className="mx-2 mt-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 rounded-xl border border-demo/25 bg-demo-soft px-4 py-2 text-center text-xs text-demo lg:mx-4">
      <Badge tone="demo" className="font-semibold uppercase tracking-wide">
        Demo data
      </Badge>
      <span>Every property and rent shown is synthetic sample data, not a real listing.</span>
      {user?.role === "admin" ? (
        <Link href="/admin/users#data-sources" className="font-medium underline underline-offset-2">
          Connect live data
        </Link>
      ) : null}
    </div>
  );
}

/** Light / dark switch. Dark is the default; the choice is remembered on this device. */
function ThemeToggle() {
  const [dark, setDark] = React.useState(true);
  React.useEffect(() => setDark(document.documentElement.classList.contains("dark")), []);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      /* storage unavailable: the choice lasts for this page view */
    }
  };
  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} title={dark ? "Light theme" : "Dark theme"}>
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}

/** Phone and tablet tab bar: the main destinations one tap away, plus "More" for everything else. */
function BottomNav({ onMore, moreOpen }: { onMore: () => void; moreOpen: boolean }) {
  const pathname = usePathname();
  const { user } = useSession();
  const { compare } = useApp();
  const tabs: { href: string; label: string; icon: typeof Search; badge?: number }[] = [
    { href: "/", label: "Search", icon: Search },
    { href: "/compare", label: "Compare", icon: GitCompareArrows, badge: compare.length },
    user ? { href: "/saved", label: "Saved", icon: Bookmark } : { href: "/pricing", label: "Plans", icon: CreditCard },
  ];
  const item = "relative flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-xl px-1 py-1.5 text-[11px] font-medium leading-none transition-colors";
  return (
    <nav aria-label="Primary" className="tabbar glass-strong fixed inset-x-2 z-40 flex items-stretch gap-1 rounded-2xl p-1 lg:hidden">
      {tabs.map(({ href, label, icon: Icon, badge }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link key={href} href={href} aria-current={active ? "page" : undefined} className={cn(item, active ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:text-foreground")}>
            <Icon className={cn("size-6", active && "text-primary")} weight={active ? "fill" : "regular"} aria-hidden />
            <span className="max-w-full truncate">{label}</span>
            {badge ? <span className="tnum absolute right-[calc(50%-1.25rem)] top-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">{badge}</span> : null}
          </Link>
        );
      })}
      <button type="button" onClick={onMore} aria-expanded={moreOpen} aria-label="More pages" className={cn(item, moreOpen ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
        <Menu className="size-6" aria-hidden />
        <span>More</span>
      </button>
    </nav>
  );
}

function Aurora() {
  return (
    <div className="aurora" aria-hidden>
      <span />
      <span />
      <span />
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
        <AppRuntime />
        <Aurora />
        <DemoBanner />
        <div key={pathname} className="page-enter">
          {children}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <Aurora />
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:text-primary-foreground">
        Skip to content
      </a>
      <aside className="glass safe-sticky sticky m-2 hidden h-[calc(100dvh-1rem-var(--sat))] w-60 shrink-0 flex-col gap-6 rounded-2xl px-3 py-4 lg:flex">
        <Brand />
        <NavLinks />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <DemoBanner />
        <header className="glass safe-sticky sticky z-30 mx-2 mt-2 flex h-14 items-center gap-3 rounded-2xl px-3 lg:ml-0 lg:mr-4 lg:px-4">
          <div className="lg:hidden">
            <Brand />
          </div>
          <div className="body-6 hidden items-center gap-2 text-muted-foreground lg:flex">
            <Building2 className="size-4" aria-hidden />
            Residential investment analysis · United States
          </div>
          <div className="ml-auto flex items-center gap-2">
            <PlanChip />
            <ThemeToggle />
            <Notifications />
            <UserMenu />
          </div>
        </header>
        <main id="main" className="flex-1 pb-[var(--tabbar-space)] lg:pb-0">
          <div key={pathname} className="page-enter">
            {children}
          </div>
        </main>
        <footer className="caption-5 text-pretty px-4 py-6 text-center text-muted-foreground lg:px-6">
          Estimates and projections are for research only and are not financial, legal or tax advice. Verify listings, rents and taxes independently before investing.
        </footer>
      </div>
      <BottomNav onMore={() => setMobileOpen(true)} moreOpen={mobileOpen} />
      <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
        <DialogContent side="left" title="PropertyYield AI">
          <NavLinks onNavigate={() => setMobileOpen(false)} />
        </DialogContent>
      </Dialog>
      <AppRuntime />
    </div>
  );
}
