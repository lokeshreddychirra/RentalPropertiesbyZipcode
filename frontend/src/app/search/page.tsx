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
        heading={
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Search properties</h1>
            <p className="text-sm text-muted-foreground">Every listing is analysed as a long-term and short-term rental and ranked by calculated returns.</p>
          </div>
        }
        idle={
          <EmptyState icon={<Search />} title="Set a location to begin">
            Enter a city and state, one or more ZIP codes, or a state above.
          </EmptyState>
        }
      />
    </React.Suspense>
  );
}
