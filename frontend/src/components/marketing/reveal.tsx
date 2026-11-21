"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/** Section that rises 32px and fades in the first time it enters the viewport (never replays). */
export function Reveal({ as: Tag = "section", className, children, ...props }: { as?: "section" | "div"; className?: string; children: React.ReactNode } & React.HTMLAttributes<HTMLElement>) {
  const ref = React.useRef<HTMLElement | null>(null);
  const [shown, setShown] = React.useState(false);
  React.useEffect(() => {
    const node = ref.current;
    if (!node || shown) return;
    if (typeof IntersectionObserver === "undefined") return setShown(true);
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShown(true);
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [shown]);
  return (
    <Tag ref={ref as React.Ref<HTMLDivElement>} data-shown={shown} className={cn("reveal", className)} {...props}>
      {children}
    </Tag>
  );
}

/**
 * Large tagline whose words light up one at a time, in reading order, as each crosses a
 * trigger line 40% up from the bottom of the viewport. Words stay lit once reached.
 * Under prefers-reduced-motion the CSS shows the final text immediately.
 */
export function TaglineReveal({ lines, className }: { lines: string[]; className?: string }) {
  const container = React.useRef<HTMLParagraphElement | null>(null);
  // `target`: words that have crossed the trigger line. `lit` catches up one word at a time,
  // so a line that crosses all at once still lights word by word in reading order.
  const [target, setTarget] = React.useState(0);
  const [lit, setLit] = React.useState(0);
  React.useEffect(() => {
    if (lit >= target) return;
    const timer = setTimeout(() => setLit((current) => current + 1), 70);
    return () => clearTimeout(timer);
  }, [lit, target]);
  const words = React.useMemo(() => lines.map((line) => line.split(" ")), [lines]);
  const total = words.reduce((sum, line) => sum + line.length, 0);

  React.useEffect(() => {
    const node = container.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") return setTarget(total);
    const spans = Array.from(node.querySelectorAll<HTMLSpanElement>("[data-word]"));
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = Number((entry.target as HTMLElement).dataset.word);
          setTarget((current) => Math.max(current, index + 1));
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -40% 0px" },
    );
    spans.forEach((span) => observer.observe(span));
    return () => observer.disconnect();
  }, [total]);

  let index = -1;
  return (
    <p ref={container} className={cn("max-w-[680px] text-balance", className)}>
      {words.map((line, li) => (
        <React.Fragment key={li}>
          {line.map((word, wi) => {
            index += 1;
            return (
              <React.Fragment key={wi}>
                <span data-word={index} data-on={index < lit} className="reveal-word">
                  {word}
                </span>{" "}
              </React.Fragment>
            );
          })}
          {li < words.length - 1 ? <br className="hidden sm:block" /> : null}
        </React.Fragment>
      ))}
    </p>
  );
}
