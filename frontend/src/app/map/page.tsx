"use client";

import * as React from "react";
import { Map as MapIcon } from "lucide-react";
import { SearchExperience } from "@/components/search/search-experience";
import { EmptyState, Skeleton } from "@/components/ui/card";

export default function MapPage() {
  return (
    <React.Suspense fallback={<div className="p-6"><Skeleton className="h-40 w-full" /></div>}>
      <SearchExperience
        basePath="/map"
        defaultView="split"
        heading={
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Investment map</h1>
            <p className="text-sm text-muted-foreground">Explore results geographically. Markers show the asking price and are coloured by gross rental yield.</p>
          </div>
        }
        idle={
          <EmptyState icon={<MapIcon />} title="Search an area to populate the map">
            Run a search above, then pan, zoom or draw an area on the map to narrow the results. The map and the list always stay in sync.
          </EmptyState>
        }
      />
    </React.Suspense>
  );
}
