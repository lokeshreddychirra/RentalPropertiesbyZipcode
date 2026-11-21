/**
 * Runtime configuration for the browser.
 *
 * The Mapbox *public* token (pk.…) is designed to be exposed to browsers; restrict
 * it to your domains in the Mapbox dashboard. Serving it from here (instead of a
 * NEXT_PUBLIC_ build-time variable) lets one image run in any environment.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const token = process.env.MAPBOX_PUBLIC_TOKEN ?? process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";
  return Response.json(
    {
      mapboxToken: token.startsWith("pk.") ? token : null,
      mapStyle: process.env.MAPBOX_STYLE ?? "mapbox://styles/mapbox/light-v11",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
