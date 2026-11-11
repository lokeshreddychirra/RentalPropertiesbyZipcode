"use client";

import * as React from "react";

/**
 * Runs once in the browser:
 * - registers the service worker (installable app + offline page) in production;
 * - inside the iOS / Android app (Capacitor), wires the native status bar, splash screen
 *   and Android back button. The native shell injects `window.Capacitor`, so the web
 *   bundle needs no Capacitor packages.
 */

interface PluginListener {
  remove: () => Promise<void> | void;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: {
    App?: {
      addListener: (event: "backButton", cb: (e: { canGoBack: boolean }) => void) => Promise<PluginListener> | PluginListener;
      exitApp: () => Promise<void>;
    };
    StatusBar?: {
      setStyle: (o: { style: "DARK" | "LIGHT" }) => Promise<void>;
    };
    SplashScreen?: { hide: () => Promise<void> };
  };
}

declare global {
  interface Window {
    Capacitor?: CapacitorGlobal;
  }
}

export function nativePlatform(): "ios" | "android" | null {
  if (typeof window === "undefined") return null;
  const cap = window.Capacitor;
  if (!cap?.isNativePlatform?.()) return null;
  const platform = cap.getPlatform?.();
  return platform === "ios" || platform === "android" ? platform : null;
}

export function AppRuntime() {
  React.useEffect(() => {
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        /* no service worker: the site still works, just without the offline page */
      });
    }

    const platform = nativePlatform();
    if (!platform) return;
    const root = document.documentElement;
    root.classList.add("native", `native-${platform}`);
    const plugins = window.Capacitor?.Plugins ?? {};

    // Light status bar icons on the dark theme and dark icons on the light theme.
    const syncStatusBar = () => {
      plugins.StatusBar?.setStyle({ style: root.classList.contains("dark") ? "DARK" : "LIGHT" }).catch(() => {});
    };
    syncStatusBar();
    const observer = new MutationObserver(syncStatusBar);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });

    plugins.SplashScreen?.hide().catch(() => {});

    let listener: PluginListener | undefined;
    if (platform === "android" && plugins.App) {
      Promise.resolve(
        plugins.App.addListener("backButton", ({ canGoBack }) => {
          // Close an open drawer, dialog or menu first, as the system back gesture should.
          if (document.querySelector('[role="dialog"][data-state="open"], [role="menu"][data-state="open"]')) {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            return;
          }
          if (canGoBack) window.history.back();
          else plugins.App?.exitApp();
        }),
      ).then((l) => (listener = l));
    }

    return () => {
      observer.disconnect();
      listener?.remove();
    };
  }, []);

  return null;
}
