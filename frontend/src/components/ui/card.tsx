import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("rounded-xl border bg-card text-card-foreground shadow-card", className)} {...props} />
));
Card.displayName = "Card";

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1 p-5 pb-3", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-base font-semibold leading-tight tracking-tight", className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5 pt-0", className)} {...props} />;
}

const badgeVariants = cva("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap", {
  variants: {
    tone: {
      neutral: "border-border bg-secondary text-secondary-foreground",
      positive: "border-transparent bg-positive-soft text-positive",
      warning: "border-transparent bg-caution-soft text-caution",
      negative: "border-transparent bg-negative-soft text-negative",
      outline: "border-border bg-transparent text-muted-foreground",
      demo: "border-transparent bg-[#ede9fe] text-[#5b21b6]",
      solid: "border-transparent bg-primary text-primary-foreground",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}

const ALERT_STYLES = {
  info: { box: "border-[#c7d9f5] bg-[#f1f6fe] text-[#1e3a6b]", Icon: Info },
  warning: { box: "border-[#f3d9a4] bg-caution-soft text-[#6b4208]", Icon: AlertTriangle },
  error: { box: "border-[#f2c4c4] bg-negative-soft text-[#7f1d1d]", Icon: XCircle },
  success: { box: "border-[#b9e2cd] bg-positive-soft text-[#14532d]", Icon: CheckCircle2 },
  demo: { box: "border-[#d6ccfb] bg-[#f5f3ff] text-[#4c1d95]", Icon: Info },
} as const;

interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: keyof typeof ALERT_STYLES;
  title?: string;
}

export function Alert({ tone = "info", title, className, children, ...props }: AlertProps) {
  const { box, Icon } = ALERT_STYLES[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cn("flex gap-3 rounded-lg border px-4 py-3 text-sm", box, className)} {...props}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-1">
        {title ? <p className="font-semibold leading-tight">{title}</p> : null}
        <div className="leading-relaxed [&_a]:underline">{children}</div>
      </div>
    </div>
  );
}

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="scrollbar-thin w-full overflow-x-auto">
      <table className={cn("w-full caption-bottom border-collapse text-sm", className)} {...props} />
    </div>
  );
}

export function Th({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={cn("border-b bg-muted/50 px-3 py-2 text-left text-xs font-medium text-muted-foreground", className)} {...props} />;
}

export function Td({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("border-b px-3 py-2 align-middle", className)} {...props} />;
}

export function EmptyState({ icon, title, children, action }: { icon?: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-card px-6 py-12 text-center">
      {icon ? <div className="mb-3 text-muted-foreground [&_svg]:size-8">{icon}</div> : null}
      <p className="title-2 text-balance">{title}</p>
      {children ? <div className="mt-2 max-w-md text-pretty text-sm text-muted-foreground">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
