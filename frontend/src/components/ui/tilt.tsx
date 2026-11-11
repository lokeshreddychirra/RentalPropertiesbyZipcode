"use client";

import * as React from "react";

/**
 * Pointer-follow 3D tilt. Spread the returned handlers on an element that has the `tilt-3d`
 * class; they set --rx / --ry (at most `max` degrees). Off for touch and reduced motion.
 */
export function useTilt<T extends HTMLElement>(max = 5) {
  const frame = React.useRef(0);
  const enabled = React.useRef(false);

  React.useEffect(() => {
    enabled.current = window.matchMedia("(hover: hover) and (pointer: fine)").matches && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    return () => cancelAnimationFrame(frame.current);
  }, []);

  const onPointerMove = React.useCallback(
    (event: React.PointerEvent<T>) => {
      if (!enabled.current) return;
      const node = event.currentTarget;
      const { clientX, clientY } = event;
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        const rect = node.getBoundingClientRect();
        const x = (clientX - rect.left) / rect.width - 0.5;
        const y = (clientY - rect.top) / rect.height - 0.5;
        node.style.setProperty("--rx", `${(-y * max).toFixed(2)}deg`);
        node.style.setProperty("--ry", `${(x * max).toFixed(2)}deg`);
      });
    },
    [max],
  );

  const onPointerLeave = React.useCallback((event: React.PointerEvent<T>) => {
    cancelAnimationFrame(frame.current);
    event.currentTarget.style.setProperty("--rx", "0deg");
    event.currentTarget.style.setProperty("--ry", "0deg");
  }, []);

  return { onPointerMove, onPointerLeave };
}
