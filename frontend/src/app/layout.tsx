import type { Metadata, Viewport } from "next";
import { Toaster } from "sonner";
import { AppShell } from "@/components/layout/app-shell";
import { TooltipProvider } from "@/components/ui/overlays";
import { Providers } from "@/lib/store";
import "@fontsource-variable/geist";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "PropertyYield AI", template: "%s · PropertyYield AI" },
  description: "Find and analyse residential investment properties by rental yield, cash flow and risk-adjusted return.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0b0e17" };

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
          <Toaster position="bottom-right" richColors closeButton />
        </Providers>
      </body>
    </html>
  );
}
