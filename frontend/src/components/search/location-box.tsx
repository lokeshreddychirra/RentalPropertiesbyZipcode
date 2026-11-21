"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { City, Loader, LocateFixed, MapPin, Search, X } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { api, errorMessage } from "@/lib/api";
import { useAccount } from "@/lib/store";
import type { PlaceSuggestion } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Waits until typing pauses before looking places up. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

interface LocationBoxProps {
  value: string;
  onChange: (value: string) => void;
  /** A city or ZIP picked from the suggestions. */
  onPick: (place: PlaceSuggestion) => void;
  onLocate: () => void;
  locating: boolean;
}

/** The search box: a ZIP code or a city, with suggestions as you type and a "use my location" button. */
export function LocationBox({ value, onChange, onPick, onLocate, locating }: LocationBoxProps) {
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  const listId = React.useId();
  const query = useDebounced(value.trim(), 250);
  // A complete ZIP code needs no suggestions; anything else of two or more characters gets them.
  const wants = query.length >= 2 && !/^\d{5}([\s,;]+\d{5})*$/.test(query);
  const suggestions = useQuery({
    queryKey: ["places", query.toLowerCase()],
    queryFn: ({ signal }) => api.places(query, signal),
    enabled: wants,
    staleTime: 10 * 60_000,
    retry: false,
  });
  const items = wants && open ? (suggestions.data ?? []) : [];
  const showList = items.length > 0;

  React.useEffect(() => setActive(-1), [query]);

  const pick = (item: PlaceSuggestion) => {
    setOpen(false);
    onPick(item);
  };

  return (
    <div className="relative min-w-0 flex-1">
      <MapPin className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input
        id="f-location"
        role="combobox"
        aria-label="ZIP code or city"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
        placeholder="ZIP code or city, like 38116 or Memphis, TN"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!showList) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => (i + 1) % items.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => (i <= 0 ? items.length - 1 : i - 1));
          } else if (e.key === "Enter" && active >= 0) {
            e.preventDefault();
            pick(items[active]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        autoComplete="off"
        spellCheck={false}
        className="body-3 h-12 rounded-lg pl-12 pr-12"
      />
      <button
        type="button"
        onClick={onLocate}
        disabled={locating}
        title="Search where I am"
        aria-label="Search where I am"
        data-testid="locate-me"
        className="absolute right-2 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60"
      >
        {locating ? <Loader className="size-5 animate-spin motion-reduce:animate-none" aria-hidden /> : <LocateFixed className="size-5" aria-hidden />}
      </button>
      {showList ? (
        <ul id={listId} role="listbox" aria-label="Suggestions" className="glass absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-xl border p-1 shadow-xl" data-testid="place-suggestions">
          {items.map((item, i) => (
            <li
              key={item.label}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(item)}
              onMouseEnter={() => setActive(i)}
              className={cn("flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2", i === active && "bg-muted")}
            >
              {item.kind === "place" ? <City className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : <MapPin className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
              <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
              <span className="caption-5 shrink-0 text-muted-foreground">{item.kind === "place" ? "City" : "ZIP code"}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** How many ZIP codes a city search can cover at once (matches the server). */
export const CITY_MAX_ZIPS = 10;

interface CityPickerProps {
  place: PlaceSuggestion;
  onSearch: (zips: string[], label: string) => void;
  onCancel: () => void;
}

/** After choosing a city: its ZIP codes, ticked up to the limit, and what searching them uses of the plan. */
export function CityZipPicker({ place, onSearch, onCancel }: CityPickerProps) {
  const account = useAccount();
  const unlimited = account.data?.unlimited ?? false;
  const found = useQuery({
    queryKey: ["place-zips", place.label, place.latitude.toFixed(3), place.longitude.toFixed(3)],
    queryFn: () => api.placeZips(place),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const data = found.data;
  const max = data?.max_zips ?? CITY_MAX_ZIPS;
  const [chosen, setChosen] = React.useState<string[] | null>(null);
  // Start with the most covered ZIP codes ticked, as many as the plan and the limit allow.
  React.useEffect(() => {
    if (!data) return;
    const zips = data.zip_codes;
    const left = data.searches_left;
    let budget = max;
    if (left != null) {
      const alreadyUsed = zips.filter((z) => !data.new_zip_codes.includes(z));
      budget = Math.min(max, alreadyUsed.length + left);
    }
    setChosen(zips.slice(0, Math.max(1, budget)));
  }, [data, max]);

  const picked = chosen ?? [];
  const newCount = data ? picked.filter((z) => data.new_zip_codes.includes(z)).length : 0;
  const left = data?.searches_left ?? null;
  const blocked = left != null && newCount > left;
  const toggle = (zip: string) =>
    setChosen((current) => {
      const list = current ?? [];
      if (list.includes(zip)) return list.filter((z) => z !== zip);
      return list.length >= max ? list : [...list, zip];
    });

  return (
    <div className="space-y-3 rounded-xl border bg-card/60 p-3" data-testid="city-picker">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="title-4 flex items-center gap-2">
            <City className="size-4 text-muted-foreground" aria-hidden /> {data?.place ?? place.label}
          </p>
          <p className="caption-5 text-muted-foreground">
            {found.isLoading
              ? "Finding the ZIP codes in this city…"
              : data?.zip_codes.length
                ? data.zip_codes.length > max
                  ? `${data.zip_codes.length} ZIP codes found. Pick up to ${max} to search at once.`
                  : `${data.zip_codes.length} ZIP ${data.zip_codes.length === 1 ? "code" : "codes"} found. Untick any you want to skip.`
                : null}
          </p>
        </div>
        <button type="button" onClick={onCancel} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close city search">
          <X className="size-4" aria-hidden />
        </button>
      </div>

      {found.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader className="size-4 animate-spin motion-reduce:animate-none" aria-hidden /> This takes a couple of seconds
        </div>
      ) : found.error ? (
        <p className="text-sm text-destructive">{errorMessage(found.error)}</p>
      ) : data && !data.zip_codes.length ? (
        <p className="text-sm text-muted-foreground">{data.message ?? "No ZIP codes were found for this city."} Try a ZIP code instead.</p>
      ) : data ? (
        <>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="ZIP codes to search">
            {data.zip_codes.map((zip) => {
              const on = picked.includes(zip);
              const full = !on && picked.length >= max;
              return (
                <button
                  key={zip}
                  type="button"
                  aria-pressed={on}
                  disabled={full}
                  onClick={() => toggle(zip)}
                  className={cn(
                    "caption-4 tnum inline-flex h-8 items-center gap-1 rounded-full border px-3 transition-[color,background-color,border-color] disabled:opacity-40",
                    on ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted",
                  )}
                >
                  {zip}
                  {!unlimited && !data.new_zip_codes.includes(zip) ? <span className="opacity-70">· searched</span> : null}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button size="sm" disabled={!picked.length || blocked} onClick={() => onSearch(data.zip_codes.filter((z) => picked.includes(z)), data.place)} data-testid="search-city">
              <Search /> Search {picked.length} ZIP {picked.length === 1 ? "code" : "codes"}
            </Button>
            {unlimited || left == null ? null : blocked ? (
              <p className="caption-5 text-caution">
                That is {newCount} new ZIP searches and you have {left} left. Untick some, or{" "}
                <Link href="/pricing" className="underline">
                  get more searches
                </Link>
                .
              </p>
            ) : (
              <p className="caption-5 text-muted-foreground">
                {newCount ? `Uses ${newCount} new ZIP ${newCount === 1 ? "search" : "searches"} · ${left} left` : "Already searched: uses no new ZIP searches."}
              </p>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
