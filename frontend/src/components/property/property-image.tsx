/* eslint-disable @next/next/no-img-element */
import { cn } from "@/lib/utils";

const PALETTES = [
  { sky: "#e8f0fb", wall: "#f4f1ea", roof: "#3f5873", door: "#2a78d6", ground: "#d7e6d0" },
  { sky: "#eef3f1", wall: "#faf7f2", roof: "#5b6b5a", door: "#b4532a", ground: "#dfe7cf" },
  { sky: "#f3eefa", wall: "#f6f3ee", roof: "#4b4763", door: "#1b7f6b", ground: "#dbe5d6" },
  { sky: "#fdf1e7", wall: "#fbf8f3", roof: "#6a4a3c", door: "#35618f", ground: "#e2e6cf" },
  { sky: "#e9f4f6", wall: "#f5f2ec", roof: "#2f4b57", door: "#a8456a", ground: "#d5e4d3" },
];

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function Illustration({ seed, type }: { seed: string; type?: string | null }) {
  const h = hash(seed);
  const p = PALETTES[h % PALETTES.length];
  const tall = type === "condo" || type === "apartment";
  const wide = type === "multi_family" || type === "townhouse";
  const variant = (h >> 4) % 3;
  return (
    <svg viewBox="0 0 320 200" className="size-full" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <rect width="320" height="200" fill={p.sky} />
      <circle cx={250 - (h % 40)} cy="46" r="18" fill="#ffffff" opacity="0.7" />
      <rect y="150" width="320" height="50" fill={p.ground} />
      {tall ? (
        <g>
          <rect x="112" y="38" width="96" height="114" rx="3" fill={p.wall} stroke={p.roof} strokeWidth="2" />
          <rect x="108" y="32" width="104" height="10" rx="2" fill={p.roof} />
          {[0, 1, 2, 3].map((row) =>
            [0, 1, 2].map((col) => <rect key={`${row}-${col}`} x={124 + col * 28} y={50 + row * 24} width="16" height="14" rx="1.5" fill={p.sky} stroke={p.roof} strokeWidth="1.2" />),
          )}
          <rect x="151" y="134" width="18" height="18" rx="1.5" fill={p.door} />
        </g>
      ) : wide ? (
        <g>
          {[0, 1].map((unit) => (
            <g key={unit} transform={`translate(${72 + unit * 92},0)`}>
              <polygon points="-6,92 42,52 90,92" fill={p.roof} />
              <rect x="0" y="92" width="84" height="60" fill={p.wall} stroke={p.roof} strokeWidth="2" />
              <rect x="12" y="104" width="20" height="18" rx="1.5" fill={p.sky} stroke={p.roof} strokeWidth="1.2" />
              <rect x="52" y="104" width="20" height="18" rx="1.5" fill={p.sky} stroke={p.roof} strokeWidth="1.2" />
              <rect x="34" y="126" width="16" height="26" rx="1.5" fill={p.door} />
            </g>
          ))}
        </g>
      ) : (
        <g>
          <polygon points={variant === 1 ? "78,96 160,44 242,96" : "70,98 160,50 250,98"} fill={p.roof} />
          {variant === 2 ? <rect x="204" y="52" width="14" height="30" fill={p.roof} /> : null}
          <rect x="86" y="96" width="148" height="56" fill={p.wall} stroke={p.roof} strokeWidth="2" />
          <rect x="100" y="108" width="26" height="22" rx="1.5" fill={p.sky} stroke={p.roof} strokeWidth="1.2" />
          <rect x="194" y="108" width="26" height="22" rx="1.5" fill={p.sky} stroke={p.roof} strokeWidth="1.2" />
          <rect x="150" y="116" width="20" height="36" rx="1.5" fill={p.door} />
          {variant === 0 ? <rect x="140" y="148" width="40" height="5" fill={p.roof} opacity="0.5" /> : null}
        </g>
      )}
      <ellipse cx="44" cy="150" rx="22" ry="26" fill="#9dbf9a" />
      <rect x="42" y="150" width="4" height="18" fill="#7a6a58" />
      <ellipse cx="286" cy="154" rx="16" ry="20" fill="#a9c7a1" />
    </svg>
  );
}

interface Props {
  id: string;
  url?: string | null;
  type?: string | null;
  alt: string;
  className?: string;
  /** Show the small "illustration" caption (cards hide it to save space). */
  caption?: boolean;
}

/**
 * Listing photo when the provider supplies one; otherwise a neutral generated
 * illustration. The illustration is deliberately abstract so it can never be
 * mistaken for a photo of the actual property.
 */
export function PropertyImage({ id, url, type, alt, className, caption = false }: Props) {
  return (
    <div className={cn("relative overflow-hidden bg-muted", className)}>
      {url ? <img src={url} alt={alt} loading="lazy" className="size-full object-cover" referrerPolicy="no-referrer" /> : <Illustration seed={id} type={type} />}
      {!url && caption ? (
        <span className="absolute bottom-2 left-2 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white">Illustration — no listing photo available</span>
      ) : null}
      {!url ? <span className="sr-only">{alt} (illustration; no listing photo available)</span> : null}
    </div>
  );
}
