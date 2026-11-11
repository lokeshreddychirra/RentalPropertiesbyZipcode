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
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        secondary: { DEFAULT: "hsl(var(--secondary))", foreground: "hsl(var(--secondary-foreground))" },
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        destructive: { DEFAULT: "hsl(var(--destructive))", foreground: "hsl(var(--destructive-foreground))" },
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
        popover: { DEFAULT: "hsl(var(--popover))", foreground: "hsl(var(--popover-foreground))" },
        // Semantic status colours: reserved for state, never used as chart series.
        positive: { DEFAULT: "hsl(var(--positive))", soft: "hsl(var(--positive-soft))" },
        caution: { DEFAULT: "hsl(var(--caution))", soft: "hsl(var(--caution-soft))" },
        negative: { DEFAULT: "hsl(var(--negative))", soft: "hsl(var(--negative-soft))" },
      },
      // Tailwind's own radius scale (sm 2 · md 6 · lg 8 · xl 12 · 2xl 16); no custom radii.
      // Motion: weighted deceleration everywhere; never a browser default curve.
      transitionTimingFunction: { DEFAULT: "cubic-bezier(0.22, 1, 0.36, 1)", out: "cubic-bezier(0.22, 1, 0.36, 1)" },
      transitionDuration: { DEFAULT: "300ms" },
      boxShadow: { card: "0 1px 2px rgb(16 24 40 / 0.04), 0 1px 3px rgb(16 24 40 / 0.06)" },
    },
  },
  plugins: [animate],
};

export default config;
