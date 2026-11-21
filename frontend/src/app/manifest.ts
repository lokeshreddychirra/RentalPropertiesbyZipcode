import type { MetadataRoute } from "next";

/** Web app manifest: lets phones and desktops install PropertyYield as an app. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "PropertyYield AI",
    short_name: "PropertyYield",
    description: "Find rental properties that pay. Every home for sale in a ZIP code, ranked by cash flow, cap rate and cash on cash return.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0b0e17",
    theme_color: "#0b0e17",
    categories: ["finance", "business", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Map view", url: "/?view=map", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
