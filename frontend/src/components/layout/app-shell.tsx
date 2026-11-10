"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, Bell, Bookmark, Building2, GitCompareArrows, LayoutDashboard, LogOut, Map as MapIcon, Menu, Search, Settings, TrendingUp, User as UserIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTrigger, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/overlays";
import { api } from "@/lib/api";
import { useApp, useSession, useStatus } from "@/lib/store";
import { cn, relativeTime } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/search", label: "Search Properties", icon: Search },
  { href: "/map", label: "Investment Map", icon: MapIcon },
  { href: "/compare", label: "Property Comparison", icon: GitCompareArrows },
  { href: "/saved", label: "Saved Properties", icon: Bookmark },
  { href: "/market", label: "Market Analytics", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
];

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
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV.map(({ href, label, icon: Icon }) => {
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

function DataModeNote() {
  const { data } = useStatus();
  if (!data) return null;
  return (
    <div className="rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
      <div className="mb-1 flex items-center gap-2">
        <span className={cn("size-2 rounded-full", data.data_mode === "live" ? "bg-positive" : "bg-[#7c3aed]")} aria-hidden />
        <span className="font-semibold text-foreground">{data.data_mode === "live" ? "Live data" : "Demo data"}</span>
      </div>
      {data.data_mode === "live" ? "Listings and estimates come from your configured providers." : "Sample properties only. Add API keys in Settings to search live listings."}
    </div>
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

function UserMenu() {
  const { user, loading, refresh } = useSession();
  const router = useRouter();
  const client = useQueryClient();
  if (loading) return <div className="size-9" />;
  if (!user) {
    return (
      <Button asChild variant="outline" size="sm">
        <Link href="/login">Sign in</Link>
      </Button>
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
          <Link href="/settings">
            <Settings /> Settings
          </Link>
        </DropdownMenuItem>
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
  if (!data || data.data_mode !== "demo") return null;
  return (
    <div role="status" className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 border-b border-[#d6ccfb] bg-[#f5f3ff] px-4 py-1.5 text-center text-xs text-[#4c1d95]">
      <Badge tone="demo" className="font-semibold uppercase tracking-wide">
        Demo data
      </Badge>
      <span>Every property, rent and short-term rental figure shown is synthetic sample data — not a real listing.</span>
      <Link href="/settings#data-sources" className="font-medium underline underline-offset-2">
        Connect live data
      </Link>
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
        <div className="mt-auto">
          <DataModeNote />
        </div>
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
              <div className="mt-6">
                <DataModeNote />
              </div>
            </DialogContent>
          </Dialog>
          <div className="lg:hidden">
            <Brand />
          </div>
          <div className="hidden items-center gap-2 text-sm text-muted-foreground lg:flex">
            <Building2 className="size-4" aria-hidden />
            Residential investment analysis · United States
          </div>
          <div className="ml-auto flex items-center gap-1">
            <Notifications />
            <UserMenu />
          </div>
        </header>
        <main id="main" className="flex-1">
          {children}
        </main>
        <footer className="border-t px-4 py-4 text-center text-[11px] leading-relaxed text-muted-foreground lg:px-6">
          Estimates and projections are for research only and are not financial, legal or tax advice. Verify listings, rents, taxes and local short-term rental rules
          independently before investing.
        </footer>
      </div>
    </div>
  );
}
