import type { Metadata, Viewport } from "next";
import { Toaster } from "sonner";
import { AppShell } from "@/components/layout/app-shell";
import { TooltipProvider } from "@/components/ui/overlays";
import { Providers } from "@/lib/store";
import "@fontsource-variable/geist";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "PropertyYield AI", template: "%s · PropertyYield AI" },
  description: "Type any US ZIP code and see every home for sale ranked as a rental by monthly cash flow, cap rate and cash on cash return. Your first search is free.",
  applicationName: "PropertyYield AI",
  appleWebApp: { capable: true, title: "PropertyYield", statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#0b0e17" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        {/* Apply the saved theme before first paint (dark is the default). */}
        <script dangerouslySetInnerHTML={{ __html: `try{if(localStorage.getItem("theme")==="light")document.documentElement.classList.remove("dark")}catch(e){}` }} />
      </head>
      <body className="font-sans">
        <Providers>
          <TooltipProvider>
            <AppShell>{children}</AppShell>
          </TooltipProvider>
          <Toaster position="bottom-right" richColors closeButton mobileOffset={{ bottom: "calc(var(--tabbar-space) + 8px)" }} />
        </Providers>
      </body>
    </html>
  );
}
