import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const config: Config = {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    container: { center: true, padding: "1rem", screens: { "2xl": "1440px" } },
    extend: {
      fontFamily: { sans: ["var(--font-sans)", "system-ui", "sans-serif"] },
      colors: {
        border: "hsl(var(--border) / <alpha-value>)",
        input: "hsl(var(--input) / <alpha-value>)",
        ring: "hsl(var(--ring) / <alpha-value>)",
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        primary: { DEFAULT: "hsl(var(--primary) / <alpha-value>)", foreground: "hsl(var(--primary-foreground) / <alpha-value>)" },
        secondary: { DEFAULT: "hsl(var(--secondary) / <alpha-value>)", foreground: "hsl(var(--secondary-foreground) / <alpha-value>)" },
        muted: { DEFAULT: "hsl(var(--muted) / <alpha-value>)", foreground: "hsl(var(--muted-foreground) / <alpha-value>)" },
        accent: { DEFAULT: "hsl(var(--accent) / <alpha-value>)", foreground: "hsl(var(--accent-foreground) / <alpha-value>)" },
        destructive: { DEFAULT: "hsl(var(--destructive) / <alpha-value>)", foreground: "hsl(var(--destructive-foreground) / <alpha-value>)" },
        card: { DEFAULT: "hsl(var(--card) / <alpha-value>)", foreground: "hsl(var(--card-foreground) / <alpha-value>)" },
        popover: { DEFAULT: "hsl(var(--popover) / <alpha-value>)", foreground: "hsl(var(--popover-foreground) / <alpha-value>)" },
        // Semantic status colours: reserved for state, never used as chart series.
        positive: { DEFAULT: "hsl(var(--positive) / <alpha-value>)", soft: "hsl(var(--positive-soft) / <alpha-value>)" },
        caution: { DEFAULT: "hsl(var(--caution) / <alpha-value>)", soft: "hsl(var(--caution-soft) / <alpha-value>)" },
        negative: { DEFAULT: "hsl(var(--negative) / <alpha-value>)", soft: "hsl(var(--negative-soft) / <alpha-value>)" },
        info: { DEFAULT: "hsl(var(--info) / <alpha-value>)", soft: "hsl(var(--info-soft) / <alpha-value>)" },
        demo: { DEFAULT: "hsl(var(--demo) / <alpha-value>)", soft: "hsl(var(--demo-soft) / <alpha-value>)" },
      },
      // Tailwind's own radius scale (sm 2 · md 6 · lg 8 · xl 12 · 2xl 16); no custom radii.
      // Motion: weighted deceleration everywhere; never a browser default curve.
      transitionTimingFunction: { DEFAULT: "cubic-bezier(0.22, 1, 0.36, 1)", out: "cubic-bezier(0.22, 1, 0.36, 1)" },
      transitionDuration: { DEFAULT: "300ms" },
      boxShadow: {
        card: "var(--glass-shadow)",
        glow: "0 8px 28px -8px rgb(var(--glow) / 0.65)",
      },
    },
  },
  plugins: [animate],
};

export default config;
