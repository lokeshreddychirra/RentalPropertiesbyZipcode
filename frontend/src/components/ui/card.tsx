import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("glass rounded-2xl text-card-foreground", className)} {...props} />
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
      demo: "border-transparent bg-demo-soft text-demo",
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
  info: { box: "border-info/25 bg-info-soft text-info", Icon: Info },
  warning: { box: "border-caution/30 bg-caution-soft text-caution", Icon: AlertTriangle },
  error: { box: "border-negative/30 bg-negative-soft text-negative", Icon: XCircle },
  success: { box: "border-positive/30 bg-positive-soft text-positive", Icon: CheckCircle2 },
  demo: { box: "border-demo/25 bg-demo-soft text-demo", Icon: Info },
} as const;

interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: keyof typeof ALERT_STYLES;
  title?: string;
}

export function Alert({ tone = "info", title, className, children, ...props }: AlertProps) {
  const { box, Icon } = ALERT_STYLES[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cn("flex gap-3 rounded-xl border px-4 py-3 text-sm backdrop-blur-sm", box, className)} {...props}>
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
    <div className="glass flex flex-col items-center justify-center rounded-2xl border-dashed px-6 py-12 text-center">
      {icon ? <div className="mb-3 text-muted-foreground [&_svg]:size-8">{icon}</div> : null}
      <p className="title-2 text-balance">{title}</p>
      {children ? <div className="mt-2 max-w-md text-pretty text-sm text-muted-foreground">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
