"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

/** The map now lives on the dashboard as a view; keep old /map links (and their filters) working. */
export default function MapRedirect() {
  const router = useRouter();
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    params.set("view", "map");
    router.replace(`/?${params}${window.location.hash}`);
  }, [router]);
  return null;
}
