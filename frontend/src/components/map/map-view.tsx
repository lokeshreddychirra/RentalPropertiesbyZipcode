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
  /** Fired (debounced) when the viewport changes. `byUser` is true once the user has moved the map since it last fitted the results. */
  onBoundsChange?: (bounds: Bounds, byUser: boolean) => void;
  polygon?: LngLat[] | null;
  onPolygonChange?: (polygon: LngLat[] | null) => void;
  allowDraw?: boolean;
  className?: string;
  /** Extra static markers (e.g. comparables) rendered as small dots. */
  secondary?: { latitude: number; longitude: number; label: string }[];
  interactive?: boolean;
  /** Floating content at the top centre of the map (hidden while drawing), e.g. "Search this ZIP". */
  overlay?: React.ReactNode;
  /** Rendered in place of the default Apply button once a drawn shape is closed. */
  pendingPanel?: (shape: LngLat[], controls: { redraw: () => void; cancel: () => void }) => React.ReactNode;
  /** When set, the drawing hint asks the user to zoom in if the map is zoomed far out. */
  areaZipLimit?: number;
}

/** Below this zoom level a drawn shape would usually cover far more than a handful of ZIP codes. */
const MIN_DRAW_ZOOM = 10;

/** Screen distance (px) a press must travel before it counts as a drag-to-draw stroke rather than a click. */
const STROKE_START_PX = 6;
/** The most vertices kept from a freehand stroke (the results API accepts up to 200). */
const MAX_STROKE_POINTS = 120;

function thin(points: LngLat[]): LngLat[] {
  if (points.length <= MAX_STROKE_POINTS) return points;
  const step = points.length / MAX_STROKE_POINTS;
  return Array.from({ length: MAX_STROKE_POINTS }, (_, i) => points[Math.floor(i * step)]);
}

/** Ray-casting point-in-polygon test (same rule the results API uses). */
function inside(lng: number, lat: number, polygon: LngLat[]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Search-area line colour: a bright blue that reads on both the light and the dark basemap. */
const AREA_COLOR = "#3d7eff";

type PointerEvt = { lngLat: { lng: number; lat: number }; point: { x: number; y: number } };

export function MapView({ points, selectedId, hoveredId, onSelect, onBoundsChange, polygon, onPolygonChange, allowDraw = false, className, secondary = [], interactive = true, overlay, pendingPanel, areaZipLimit }: Props) {
  const { lib, config } = useMapLibrary();
  const mapRef = React.useRef<import("react-map-gl/maplibre").MapRef | null>(null);
  const [view, setView] = React.useState<{ bounds: Bounds; zoom: number } | null>(null);
  const [drawing, setDrawing] = React.useState(false);
  const [draft, setDraft] = React.useState<LngLat[]>([]);
  // True once the current drawing is a freehand stroke (drawn as a plain line, no corner dots).
  const [freehand, setFreehand] = React.useState(false);
  // A closed shape waiting for the user to press Apply.
  const [pending, setPending] = React.useState<LngLat[] | null>(null);
  const [popupId, setPopupId] = React.useState<string | null>(null);
  const boundsTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const movedByUser = React.useRef(false);
  const lastTouch = React.useRef(0);
  // The press currently being drawn: where it started (screen px) and the points collected so far.
  const stroke = React.useRef<{ start: { x: number; y: number }; last: { x: number; y: number }; points: LngLat[]; dragging: boolean } | null>(null);

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
      const byUser = movedByUser.current;
      boundsTimer.current = setTimeout(() => onBoundsChange(bounds, byUser), 350);
    }
  }, [onBoundsChange]);

  // Fit to the result set whenever it changes.
  const fitKey = React.useMemo(() => `${points.length}:${points[0]?.id ?? ""}:${points[points.length - 1]?.id ?? ""}`, [points]);
  const fit = React.useCallback(() => {
    const map = mapRef.current;
    if (!map || !points.length) return;
    movedByUser.current = false;
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

  // A new search (with or without an area) replaces any shape still waiting to be applied.
  const polygonKey = polygon?.length ? JSON.stringify(polygon) : "";
  React.useEffect(() => {
    setPending(null);
  }, [polygonKey]);

  if (!lib || !config) return <Skeleton className={cn("min-h-[320px] w-full", className)} />;
  const { default: MapGL, Marker, Popup, Source, Layer, NavigationControl } = lib;
  const usingMapbox = !!config.mapboxToken;
  const shape = drawing ? draft : (pending ?? polygon ?? []);
  const closed = !drawing || (!freehand && draft.length >= 3);
  const homesInPending = pending ? points.filter((p) => inside(p.longitude, p.latitude, pending)).length : 0;
  const popupPoint = popupId ? byId.get(popupId) : null;

  const startDrawing = () => {
    setPending(null);
    setDraft([]);
    setFreehand(false);
    setDrawing(true);
  };
  const stopDrawing = () => {
    setDrawing(false);
    setDraft([]);
    setFreehand(false);
    stroke.current = null;
  };
  /** Close the shape and wait for Apply. */
  const finish = (shapePoints: LngLat[] = draft) => {
    if (shapePoints.length >= 3) setPending(thin(shapePoints));
    stopDrawing();
  };
  const apply = () => {
    if (pending) onPolygonChange?.(pending);
    setPending(null);
  };

  // Drawing: press and drag to sketch the area (released = done), or click to place corner points.
  // Phones follow a touch with emulated mouse events; ignore those so a tap adds one point, not two.
  const fromMouse = (handler: (event: PointerEvt) => void) => (event: PointerEvt) => {
    if (Date.now() - lastTouch.current > 800) handler(event);
  };
  const fromTouch = (handler: (event: PointerEvt) => void) => (event: PointerEvt) => {
    lastTouch.current = Date.now();
    handler(event);
  };
  const pressStart = (event: PointerEvt) => {
    if (!drawing) return;
    const at = { x: event.point.x, y: event.point.y };
    stroke.current = { start: at, last: at, points: [[event.lngLat.lng, event.lngLat.lat]], dragging: false };
  };
  const pressMove = (event: PointerEvt) => {
    const current = stroke.current;
    if (!drawing || !current) return;
    const { x, y } = event.point;
    if (!current.dragging && Math.hypot(x - current.start.x, y - current.start.y) < STROKE_START_PX) return;
    if (!current.dragging) {
      current.dragging = true;
      setFreehand(true);
    }
    if (Math.hypot(x - current.last.x, y - current.last.y) < 4) return;
    current.last = { x, y };
    current.points.push([event.lngLat.lng, event.lngLat.lat]);
    setDraft([...current.points]);
  };
  const pressEnd = () => {
    const current = stroke.current;
    stroke.current = null;
    if (!drawing || !current) return;
    if (current.dragging) {
      if (current.points.length >= 3) finish(current.points);
      else {
        setDraft([]);
        setFreehand(false);
      }
      return;
    }
    // A click: add a corner point.
    setDraft((existing) => [...existing, current.points[0]]);
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
        dragPan={!drawing}
        dragRotate={false}
        boxZoom={!drawing}
        touchPitch={false}
        cursor={drawing ? "crosshair" : undefined}
        onLoad={() => {
          fit();
          syncView();
        }}
        onMoveStart={(event) => {
          if ((event as { originalEvent?: unknown }).originalEvent) movedByUser.current = true;
        }}
        onMoveEnd={syncView}
        onMouseDown={fromMouse(pressStart)}
        onMouseMove={fromMouse(pressMove)}
        onMouseUp={fromMouse(pressEnd)}
        onTouchStart={fromTouch(pressStart)}
        onTouchMove={fromTouch(pressMove)}
        onTouchEnd={fromTouch(pressEnd)}
        // Basemap tile failures (offline, blocked network) must not break the page: markers still render.
        onError={() => undefined}
        onClick={() => {
          if (drawing) return; // corner points are added on release (see pressEnd)
          setPopupId(null);
          onSelect?.(null);
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
              // While a freehand stroke is in progress it is an open line, like a pen; it closes on release.
              geometry: closed && shape.length >= 3 ? { type: "Polygon", coordinates: [[...shape, shape[0]]] } : { type: "LineString", coordinates: shape },
            }}
          >
            {closed && shape.length >= 3 ? <Layer id="search-area-fill" type="fill" paint={{ "fill-color": AREA_COLOR, "fill-opacity": pending ? 0.16 : 0.1 }} /> : null}
            <Layer id="search-area-line" type="line" layout={{ "line-join": "round", "line-cap": "round" }} paint={{ "line-color": AREA_COLOR, "line-width": drawing ? 3.5 : 3, "line-opacity": 0.95 }} />
          </Source>
        ) : null}
        {drawing && !freehand
          ? draft.map(([lng, lat], i) => (
              <Marker key={`v-${i}`} longitude={lng} latitude={lat}>
                <span className="block size-3 rounded-full border-2 border-white shadow" style={{ backgroundColor: AREA_COLOR }} />
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
              <Marker key={`c-${props.cluster_id}`} longitude={lng} latitude={lat} style={drawing ? { pointerEvents: "none", opacity: 0.45 } : undefined}>
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
            <Marker key={point.id} longitude={lng} latitude={lat} anchor="bottom" style={{ zIndex: active ? 5 : 1, ...(drawing ? { pointerEvents: "none" as const, opacity: 0.45 } : {}) }}>
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
          {pending && pendingPanel ? (
            pendingPanel(pending, { redraw: startDrawing, cancel: () => setPending(null) })
          ) : pending ? (
            <>
              <Button size="sm" className="shadow-lg" onClick={apply} data-testid="apply-area">
                <Check /> Apply · {homesInPending} {homesInPending === 1 ? "home" : "homes"}
              </Button>
              <Button size="sm" variant="outline" className="shadow" onClick={startDrawing}>
                <PenLine /> Redraw
              </Button>
              <Button size="sm" variant="outline" className="shadow" onClick={() => setPending(null)}>
                <X /> Cancel
              </Button>
            </>
          ) : drawing ? (
            <>
              {!freehand && draft.length >= 3 ? (
                <Button size="sm" onClick={() => finish()}>
                  <Check /> Close shape
                </Button>
              ) : null}
              <Button size="sm" variant="outline" className="shadow" onClick={stopDrawing}>
                <X /> Cancel
              </Button>
              <span className="rounded-md bg-card/95 px-2 py-1 text-[11px] text-muted-foreground shadow" data-testid="draw-hint">
                {draft.length && !freehand
                  ? `${draft.length} point${draft.length === 1 ? "" : "s"} · click to add more, double-click to close`
                  : areaZipLimit && (view?.zoom ?? 99) < MIN_DRAW_ZOOM
                    ? `Zoom in first: an area can cover up to ${areaZipLimit} ZIP codes`
                    : "Draw a shape around the area you want"}
              </span>
            </>
          ) : (
            <>
              <Button size="sm" variant="outline" className="shadow" onClick={startDrawing}>
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

      {overlay && !drawing && !pending ? <div className="pointer-events-none absolute inset-x-0 top-14 flex justify-center px-3 [&>*]:pointer-events-auto">{overlay}</div> : null}

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
