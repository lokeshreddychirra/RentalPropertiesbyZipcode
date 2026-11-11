"use client";

import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { ChevronDown } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, type, ...props }, ref) => (
  <input
    type={type}
    ref={ref}
    className={cn(
      "flex h-9 w-full rounded-lg border border-input bg-card/60 px-3 py-1 text-sm shadow-sm transition-[border-color,box-shadow] placeholder:text-muted-foreground/70 focus-visible:border-primary/60 focus-visible:shadow-glow disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn("flex min-h-[72px] w-full rounded-lg border border-input bg-card/60 px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground/70 disabled:opacity-50", className)}
    {...props}
  />
));
Textarea.displayName = "Textarea";

export const Label = React.forwardRef<React.ElementRef<typeof LabelPrimitive.Root>, React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>>(
  ({ className, ...props }, ref) => <LabelPrimitive.Root ref={ref} className={cn("text-xs font-medium leading-none text-muted-foreground", className)} {...props} />,
);
Label.displayName = "Label";

/** Native select: fully keyboard accessible and uses the platform picker on mobile. */
export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...props }, ref) => (
  <div className="relative">
    <select
      ref={ref}
      className={cn("h-9 w-full appearance-none rounded-lg border border-input bg-card/60 pl-3 pr-8 text-sm shadow-sm disabled:cursor-not-allowed disabled:opacity-50 [&>option]:bg-popover", className)}
      {...props}
    >
      {children}
    </select>
    <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
  </div>
));
Select.displayName = "Select";

export const Switch = React.forwardRef<React.ElementRef<typeof SwitchPrimitive.Root>, React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>>(
  ({ className, ...props }, ref) => (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-4 rounded-full bg-white shadow ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
    </SwitchPrimitive.Root>
  ),
);
Switch.displayName = "Switch";

interface FieldProps {
  label: string;
  htmlFor?: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}

export function Field({ label, htmlFor, hint, className, children }: FieldProps) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

interface NumberInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "prefix"> {
  value: number | null | undefined;
  onValueChange: (value: number | null) => void;
  prefix?: string;
  suffix?: string;
}

/**
 * Numeric input that keeps the user's raw text while typing (so "7." or "" do
 * not get clobbered) and reports parsed numbers upward.
 */
export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(({ value, onValueChange, prefix, suffix, className, onBlur, ...props }, ref) => {
  const [text, setText] = React.useState<string>(value === null || value === undefined ? "" : String(value));
  const focused = React.useRef(false);

  React.useEffect(() => {
    if (!focused.current) setText(value === null || value === undefined ? "" : String(value));
  }, [value]);

  return (
    <div className="relative">
      {prefix ? <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">{prefix}</span> : null}
      <Input
        ref={ref}
        inputMode="decimal"
        value={text}
        className={cn("tnum", prefix && "pl-6", suffix && "pr-8", className)}
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(event) => {
          const raw = event.target.value.replace(/[^0-9.\-]/g, "");
          setText(raw);
          if (raw === "" || raw === "-" || raw === ".") onValueChange(null);
          else {
            const parsed = Number(raw);
            if (!Number.isNaN(parsed)) onValueChange(parsed);
          }
        }}
        onBlur={(event) => {
          focused.current = false;
          setText(value === null || value === undefined ? "" : String(value));
          onBlur?.(event);
        }}
        {...props}
      />
      {suffix ? <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{suffix}</span> : null}
    </div>
  );
});
NumberInput.displayName = "NumberInput";

interface SliderProps {
  id?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onValueChange: (value: number) => void;
  /** Spoken value for screen readers, e.g. "$45,000" or "20 percent". */
  valueText?: string;
  label?: string;
  className?: string;
}

/** Native range input (keyboard, touch and screen-reader friendly) with a filled track. */
export function Slider({ id, value, min, max, step, onValueChange, valueText, label, className }: SliderProps) {
  const fill = max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0;
  return (
    <input
      id={id}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={label}
      aria-valuetext={valueText}
      onChange={(event) => onValueChange(Number(event.target.value))}
      className={cn("sim-slider", className)}
      style={{ "--fill": `${fill}%` } as React.CSSProperties}
    />
  );
}
