"use client";

import * as React from "react";
import Link from "next/link";
import Supercluster from "supercluster";
import { Check, PenLine, Trash2, X } from "@/components/ui/icons";
import "mapbox-gl/dist/mapbox-gl.css";
import "maplibre-gl/dist/maplibre-gl.css";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/card";
import type { MapPoint } from "@/lib/types";
import { cn, pct, usd, usdCompact } from "@/lib/utils";

type MapLib = typeof import("react-map-gl/maplibre");
type Bounds = [number, number, number, number]; // west, south, east, north
type LngLat = [number, number];

interface MapConfig {
  mapboxToken: string | null;
  mapStyle: string;
}

/** Fallback basemap when no Mapbox token is configured (development / demo use). */
const OSM_STYLE = {
  version: 8 as const,
  sources: {
    osm: { type: "raster" as const, tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap contributors" },
  },
  layers: [
    { id: "background", type: "background" as const, paint: { "background-color": "#eef1f5" } },
    { id: "osm", type: "raster" as const, source: "osm" },
  ],
};

// Sequential single-hue ramp for gross yield (magnitude): light → dark green.
export const YIELD_STEPS = [
  { min: 10, color: "#0b5d3b", text: "#ffffff", label: "≥ 10%" },
  { min: 8, color: "#1f8a5b", text: "#ffffff", label: "8–10%" },
  { min: 6, color: "#7cc5a1", text: "#0b3a26", label: "6–8%" },
  { min: -Infinity, color: "#d6ecdf", text: "#0b3a26", label: "< 6%" },
];
const UNKNOWN = { color: "#e5e7eb", text: "#374151", label: "No estimate" };

export function yieldStyle(value: number | null | undefined) {
  if (value === null || value === undefined) return UNKNOWN;
  return YIELD_STEPS.find((step) => value >= step.min) ?? UNKNOWN;
}

function useMapLibrary(): { lib: MapLib | null; config: MapConfig | null } {
  const [state, setState] = React.useState<{ lib: MapLib | null; config: MapConfig | null }>({ lib: null, config: null });
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      let config: MapConfig = { mapboxToken: null, mapStyle: "" };
      try {
        config = await (await fetch("/api/config")).json();
      } catch {
        /* fall back to the open basemap */
      }
      const lib = (config.mapboxToken ? await import("react-map-gl/mapbox") : await import("react-map-gl/maplibre")) as unknown as MapLib;
      if (!cancelled) setState({ lib, config });
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

interface Props {
  points: MapPoint[];
  selectedId?: string | null;
  hoveredId?: string | null;
  onSelect?: (id: string | null) => void;
  /** Fired (debounced) when the viewport changes, for "filter as I move the map". */
  onBoundsChange?: (bounds: Bounds) => void;
  polygon?: LngLat[] | null;
  onPolygonChange?: (polygon: LngLat[] | null) => void;
  allowDraw?: boolean;
  className?: string;
  /** Extra static markers (e.g. comparables) rendered as small dots. */
  secondary?: { latitude: number; longitude: number; label: string }[];
  interactive?: boolean;
}

export function MapView({ points, selectedId, hoveredId, onSelect, onBoundsChange, polygon, onPolygonChange, allowDraw = false, className, secondary = [], interactive = true }: Props) {
  const { lib, config } = useMapLibrary();
  const mapRef = React.useRef<import("react-map-gl/maplibre").MapRef | null>(null);
  const [view, setView] = React.useState<{ bounds: Bounds; zoom: number } | null>(null);
  const [drawing, setDrawing] = React.useState(false);
  const [draft, setDraft] = React.useState<LngLat[]>([]);
  const [popupId, setPopupId] = React.useState<string | null>(null);
  const boundsTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const index = React.useMemo(() => {
    const cluster = new Supercluster<{ point: MapPoint }>({ radius: 58, maxZoom: 15 });
    cluster.load(points.map((point) => ({ type: "Feature" as const, properties: { point }, geometry: { type: "Point" as const, coordinates: [point.longitude, point.latitude] } })));
    return cluster;
  }, [points]);

  const clusters = React.useMemo(() => (view ? index.getClusters(view.bounds, Math.round(view.zoom)) : []), [index, view]);
  const byId = React.useMemo(() => new Map(points.map((p) => [p.id, p])), [points]);

  const syncView = React.useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const b = map.getBounds();
    if (!b) return;
    const bounds: Bounds = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    setView({ bounds, zoom: map.getZoom() });
    if (onBoundsChange) {
      if (boundsTimer.current) clearTimeout(boundsTimer.current);
      boundsTimer.current = setTimeout(() => onBoundsChange(bounds), 350);
    }
  }, [onBoundsChange]);

  // Fit to the result set whenever it changes.
  const fitKey = React.useMemo(() => `${points.length}:${points[0]?.id ?? ""}:${points[points.length - 1]?.id ?? ""}`, [points]);
  const fit = React.useCallback(() => {
    const map = mapRef.current;
    if (!map || !points.length) return;
    let west = 180, south = 90, east = -180, north = -90;
    for (const p of points) {
      west = Math.min(west, p.longitude);
      east = Math.max(east, p.longitude);
      south = Math.min(south, p.latitude);
      north = Math.max(north, p.latitude);
    }
    if (points.length === 1) map.jumpTo({ center: [west, south], zoom: 14 });
    else map.fitBounds([[west, south], [east, north]], { padding: 56, duration: 0, maxZoom: 15 });
  }, [points]);
  React.useEffect(() => {
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  React.useEffect(() => {
    if (selectedId) setPopupId(selectedId);
  }, [selectedId]);

  if (!lib || !config) return <Skeleton className={cn("min-h-[320px] w-full", className)} />;
  const { default: MapGL, Marker, Popup, Source, Layer, NavigationControl } = lib;
  const usingMapbox = !!config.mapboxToken;
  const shape = drawing ? draft : (polygon ?? []);
  const popupPoint = popupId ? byId.get(popupId) : null;

  const finish = () => {
    if (draft.length >= 3) onPolygonChange?.(draft);
    setDrawing(false);
    setDraft([]);
  };

  return (
    <div className={cn("relative overflow-hidden rounded-lg border bg-muted", className)} data-testid="map">
      <MapGL
        ref={mapRef}
        {...(usingMapbox ? { mapboxAccessToken: config.mapboxToken as string } : {})}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mapStyle={(usingMapbox ? config.mapStyle : OSM_STYLE) as any}
        initialViewState={{ longitude: -84.39, latitude: 33.75, zoom: 9 }}
        style={{ width: "100%", height: "100%" }}
        interactive={interactive}
        doubleClickZoom={!drawing}
        cursor={drawing ? "crosshair" : undefined}
        onLoad={() => {
          fit();
          syncView();
        }}
        onMoveEnd={syncView}
        // Basemap tile failures (offline, blocked network) must not break the page: markers still render.
        onError={() => undefined}
        onClick={(event) => {
          if (drawing) setDraft((current) => [...current, [event.lngLat.lng, event.lngLat.lat]]);
          else {
            setPopupId(null);
            onSelect?.(null);
          }
        }}
        onDblClick={(event) => {
          if (drawing) {
            event.preventDefault();
            finish();
          }
        }}
        attributionControl={{ compact: true }}
      >
        {interactive ? <NavigationControl position="top-right" showCompass={false} /> : null}

        {shape.length >= 2 ? (
          <Source
            id="search-area"
            type="geojson"
            data={{
              type: "Feature",
              properties: {},
              geometry: shape.length >= 3 ? { type: "Polygon", coordinates: [[...shape, shape[0]]] } : { type: "LineString", coordinates: shape },
            }}
          >
            {shape.length >= 3 ? <Layer id="search-area-fill" type="fill" paint={{ "fill-color": "#2a78d6", "fill-opacity": 0.1 }} /> : null}
            <Layer id="search-area-line" type="line" paint={{ "line-color": "#2a78d6", "line-width": 2, "line-dasharray": drawing ? [2, 1.5] : [1, 0] }} />
          </Source>
        ) : null}
        {drawing
          ? draft.map(([lng, lat], i) => (
              <Marker key={`v-${i}`} longitude={lng} latitude={lat}>
                <span className="block size-2.5 rounded-full border-2 border-white bg-[#2a78d6] shadow" />
              </Marker>
            ))
          : null}

        {secondary.map((item, i) => (
          <Marker key={`s-${i}`} longitude={item.longitude} latitude={item.latitude}>
            <span title={item.label} className="block size-3 rounded-full border-2 border-white bg-[#6250d6] shadow" />
          </Marker>
        ))}

        {clusters.map((feature) => {
          const [lng, lat] = feature.geometry.coordinates;
          const props = feature.properties as { cluster?: boolean; point_count?: number; cluster_id?: number; point?: MapPoint };
          if (props.cluster) {
            const count = props.point_count ?? 0;
            const size = 30 + Math.min(count, 100) * 0.22;
            return (
              <Marker key={`c-${props.cluster_id}`} longitude={lng} latitude={lat}>
                <button
                  type="button"
                  aria-label={`${count} properties — zoom in`}
                  onClick={(event) => {
                    event.stopPropagation();
                    const zoom = Math.min(index.getClusterExpansionZoom(props.cluster_id as number), 17);
                    mapRef.current?.easeTo({ center: [lng, lat], zoom, duration: 400 });
                  }}
                  className="tnum flex items-center justify-center rounded-full border-2 border-white bg-primary text-xs font-semibold text-primary-foreground shadow-md"
                  style={{ width: size, height: size }}
                >
                  {count}
                </button>
              </Marker>
            );
          }
          const point = props.point as MapPoint;
          const active = point.id === selectedId || point.id === hoveredId || point.id === popupId;
          const style = yieldStyle(point.gross_yield_pct);
          return (
            <Marker key={point.id} longitude={lng} latitude={lat} anchor="bottom" style={{ zIndex: active ? 5 : 1 }}>
              <button
                type="button"
                data-testid="map-marker"
                aria-label={`${point.address}, ${usd(point.price)}${point.gross_yield_pct != null ? `, gross yield ${pct(point.gross_yield_pct)}` : ""}`}
                onClick={(event) => {
                  event.stopPropagation();
                  if (drawing) return;
                  setPopupId(point.id);
                  onSelect?.(point.id);
                }}
                className={cn("tnum rounded-full border-2 px-2 py-0.5 text-[11px] font-semibold shadow-md transition-transform", active ? "scale-110 border-primary" : "border-white")}
                style={{ backgroundColor: style.color, color: style.text }}
              >
                {usdCompact(point.price)}
              </button>
            </Marker>
          );
        })}

        {popupPoint && !drawing ? (
          <Popup longitude={popupPoint.longitude} latitude={popupPoint.latitude} anchor="top" offset={8} closeButton={false} onClose={() => setPopupId(null)} maxWidth="260px">
            <div className="w-56 p-3 text-foreground">
              <p className="tnum text-base font-semibold">{usd(popupPoint.price)}</p>
              <p className="truncate text-xs text-muted-foreground">{popupPoint.address}</p>
              <dl className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                <div>
                  <dt className="text-muted-foreground">Yield</dt>
                  <dd className="tnum font-semibold">{pct(popupPoint.gross_yield_pct)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Cash flow</dt>
                  <dd className={cn("tnum font-semibold", (popupPoint.monthly_cash_flow ?? 0) < 0 ? "text-negative" : "text-positive")}>{usd(popupPoint.monthly_cash_flow)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Score</dt>
                  <dd className="tnum font-semibold">{popupPoint.score != null ? popupPoint.score.toFixed(0) : "—"}</dd>
                </div>
              </dl>
              <Button asChild size="sm" className="mt-3 w-full">
                <Link href={`/properties/${popupPoint.id}`}>View analysis</Link>
              </Button>
            </div>
          </Popup>
        ) : null}
      </MapGL>

      {allowDraw ? (
        <div className="absolute left-3 top-3 flex flex-wrap items-center gap-1.5">
          {drawing ? (
            <>
              <Button size="sm" onClick={finish} disabled={draft.length < 3}>
                <Check /> Finish area
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setDrawing(false);
                  setDraft([]);
                }}
              >
                <X /> Cancel
              </Button>
              <span className="rounded-md bg-card/95 px-2 py-1 text-[11px] text-muted-foreground shadow">Click to add points ({draft.length}); double-click to finish</span>
            </>
          ) : (
            <>
              <Button size="sm" variant="outline" className="shadow" onClick={() => setDrawing(true)}>
                <PenLine /> {polygon?.length ? "Redraw area" : "Draw search area"}
              </Button>
              {polygon?.length ? (
                <Button size="sm" variant="outline" className="shadow" onClick={() => onPolygonChange?.(null)}>
                  <Trash2 /> Clear area
                </Button>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {points.length > 1 ? (
        <div className="absolute bottom-3 left-3 rounded-md bg-card/95 px-2.5 py-2 text-[10px] shadow" aria-label="Marker colour legend">
          <p className="mb-1 font-medium text-muted-foreground">Gross rental yield</p>
          <div className="flex items-center gap-2">
            {[...YIELD_STEPS].reverse().map((step) => (
              <span key={step.label} className="inline-flex items-center gap-1">
                <span className="size-2.5 rounded-full border border-black/10" style={{ backgroundColor: step.color }} aria-hidden />
                {step.label}
              </span>
            ))}
            <span className="inline-flex items-center gap-1">
              <span className="size-2.5 rounded-full border border-black/10" style={{ backgroundColor: UNKNOWN.color }} aria-hidden />
              n/a
            </span>
          </div>
        </div>
      ) : null}
      {!usingMapbox ? (
        <span className="absolute right-12 top-3 rounded bg-card/90 px-1.5 py-0.5 text-[10px] text-muted-foreground shadow">Open basemap · add a Mapbox token for full maps</span>
      ) : null}
    </div>
  );
}
