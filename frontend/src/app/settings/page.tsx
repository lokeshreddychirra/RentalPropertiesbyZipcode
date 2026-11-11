"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

/** Settings now live in the admin portal; keep old links working. */
export default function SettingsRedirect() {
  const router = useRouter();
  React.useEffect(() => {
    router.replace(`/admin/users${window.location.hash}`);
  }, [router]);
  return null;
}
