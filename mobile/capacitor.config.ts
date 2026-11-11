import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The iOS and Android apps load the live web app, so every deploy reaches the apps
 * immediately and sign-in cookies stay first party. `www/` only holds the page shown
 * when the server cannot be reached.
 *
 * Point a build at another deployment with:  APP_URL=https://staging.example.com npx cap sync
 */
const appUrl = process.env.APP_URL ?? "https://propertyyield.onrender.com";

const config: CapacitorConfig = {
  appId: "com.propertyyield.app",
  appName: "PropertyYield",
  webDir: "www",
  appendUserAgent: "PropertyYieldApp",
  backgroundColor: "#0b0e17",
  server: {
    url: appUrl,
    cleartext: false,
    errorPath: "offline.html",
  },
  android: {
    allowMixedContent: false,
  },
  ios: {
    contentInset: "never",
    limitsNavigationsToAppBoundDomains: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 3000,
      launchAutoHide: true,
      backgroundColor: "#0b0e17",
      showSpinner: false,
      androidScaleType: "CENTER_CROP",
      splashFullScreen: false,
      splashImmersive: false,
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: "#0b0e17",
      overlaysWebView: true,
    },
    SystemBars: {
      insetsHandling: "native",
      initialViewportFitValueHint: "cover",
    },
  },
};

export default config;
