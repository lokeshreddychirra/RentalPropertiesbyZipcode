"use client";

import * as React from "react";
import { Search } from "lucide-react";
import { SearchExperience } from "@/components/search/search-experience";
import { EmptyState, Skeleton } from "@/components/ui/card";

export default function SearchPage() {
  return (
    <React.Suspense fallback={<div className="p-6"><Skeleton className="h-40 w-full" /></div>}>
      <SearchExperience
        basePath="/search"
        advancedOpen
        heading={
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Search properties</h1>
            <p className="text-sm text-muted-foreground">Filter by location, price and return thresholds. Results are ranked from actual financial calculations.</p>
          </div>
        }
        idle={
          <EmptyState icon={<Search />} title="Set a location to begin">
            Enter a city, one or more ZIP codes, a county and state, or a state — or describe what you want in plain English above.
          </EmptyState>
        }
      />
    </React.Suspense>
  );
}
