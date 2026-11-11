"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

/** Search now lives on the dashboard; keep old /search links (and their filters) working. */
export default function SearchRedirect() {
  const router = useRouter();
  React.useEffect(() => {
    router.replace(`/${window.location.search}${window.location.hash}`);
  }, [router]);
  return null;
}
