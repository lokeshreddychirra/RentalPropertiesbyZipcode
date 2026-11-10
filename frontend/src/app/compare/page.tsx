"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, FileDown, FileSpreadsheet, GitCompareArrows, X } from "lucide-react";
import { toast } from "sonner";
import { ConfidenceBadge, DemoTag, RuleBadges, ScoreRing } from "@/components/property/bits";
import { PropertyImage } from "@/components/property/property-image";
import { Button } from "@/components/ui/button";
import { Alert, Card, EmptyState, Skeleton, Table, Td, Th } from "@/components/ui/card";
import { api, errorMessage } from "@/lib/api";
import { MAX_COMPARE, useApp } from "@/lib/store";
import type { CompareMetric, CompareResponse, Confidence } from "@/lib/types";
import { cn, pct, ratio, titleCase, usd } from "@/lib/utils";

type Filter = "all" | "ltr" | "str";

function format(metric: CompareMetric, value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return metric.key === "confidence" ? titleCase(value) : value;
  switch (metric.unit) {
    case "currency":
      return usd(value);
    case "percent":
      return pct(value, 2);
    case "ratio":
      return ratio(value);
    case "score":
      return value.toFixed(0);
    default:
      return String(value);
  }
}

function exportRows(data: CompareResponse, filter: Filter): { head: string[]; body: string[][] } {
  const head = ["Metric", ...data.items.map((item) => item.context.formatted_address)];
  const facts: string[][] = [
    ["Bedrooms / bathrooms", ...data.items.map((i) => `${i.context.bedrooms ?? "-"} / ${i.context.bathrooms ?? "-"}`)],
    ["Square feet", ...data.items.map((i) => (i.context.square_feet ? String(i.context.square_feet) : "-"))],
    ["Data", ...data.items.map((i) => (i.context.is_demo ? "DEMO (synthetic)" : (i.context.listing_source ?? "-")))],
  ];
  const metrics = data.metrics
    .filter((m) => filter === "all" || !m.strategy || m.strategy === filter)
    .map((m) => [m.label, ...m.values.map((v, i) => `${format(m, v).replace("−", "-")}${m.best_index === i ? " *" : ""}`)]);
  return { head, body: [...facts, ...metrics] };
}

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toCsv(rows: string[][]): string {
  // Neutralise spreadsheet formula injection and quote every cell.
  const cell = (text: string) => `"${(/^[=+\-@\t\r]/.test(text) && !/^-?\$?[\d.,]+%?( \*)?$/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
  return rows.map((row) => row.map(cell).join(",")).join("\r\n");
}

export default function ComparePage() {
  const { compare, removeCompare, clearCompare, defaultsOrNull, weights, hydrated } = useApp();
  const [filter, setFilter] = React.useState<Filter>("all");
  const ids = compare.map((item) => item.id);

  const query = useQuery({
    queryKey: ["compare", ids, defaultsOrNull, weights],
    queryFn: () => api.compare(ids, defaultsOrNull, weights),
    enabled: hydrated && ids.length > 0,
    retry: false,
  });
  const data = query.data;

  const exportCsv = () => {
    if (!data) return;
    const { head, body } = exportRows(data, filter);
    const note = [["PropertyYield AI comparison", new Date().toISOString()], ["* = strongest value for that metric. Figures are estimates; verify before investing."], []];
    download("property-comparison.csv", new Blob(["﻿" + toCsv([...note, head, ...body])], { type: "text/csv;charset=utf-8" }));
  };

  const exportPdf = async () => {
    if (!data) return;
    try {
      const [{ jsPDF }, { default: autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
      const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });
      const { head, body } = exportRows(data, filter);
      doc.setFontSize(15);
      doc.text("PropertyYield AI — Property comparison", 40, 40);
      doc.setFontSize(9);
      doc.setTextColor(100);
      doc.text(`Generated ${new Date().toLocaleString()} · * marks the strongest value per metric · Estimates only — verify before investing.`, 40, 56);
      if (data.items.some((item) => item.context.is_demo)) doc.text("Includes DEMO data: synthetic sample properties, not real listings.", 40, 68);
      autoTable(doc, {
        head: [head],
        body,
        startY: 80,
        styles: { fontSize: 8, cellPadding: 4, overflow: "linebreak" },
        headStyles: { fillColor: [24, 32, 56], textColor: 255, fontSize: 8 },
        columnStyles: { 0: { cellWidth: 150, fontStyle: "bold" } },
        didParseCell: (hook) => {
          if (hook.section === "body" && hook.column.index > 0 && String(hook.cell.raw).endsWith(" *")) {
            hook.cell.styles.fontStyle = "bold";
            hook.cell.styles.textColor = [22, 101, 52];
          }
        },
      });
      doc.save("property-comparison.pdf");
    } catch {
      toast.error("The PDF could not be generated.");
    }
  };

  if (hydrated && !ids.length) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-12">
        <EmptyState icon={<GitCompareArrows />} title="No properties selected" action={<Button asChild><Link href="/search">Search properties</Link></Button>}>
          Select up to {MAX_COMPARE} properties with the “Compare” button on any result card or analysis page. They will appear here side by side.
        </EmptyState>
      </div>
    );
  }

  const metrics = (data?.metrics ?? []).filter((m) => filter === "all" || !m.strategy || m.strategy === filter);

  return (
    <div className="mx-auto max-w-[1440px] space-y-5 px-4 py-5 lg:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Property comparison</h1>
          <p className="text-sm text-muted-foreground">Up to {MAX_COMPARE} properties side by side, all evaluated with your standing assumptions. The strongest value in each row is highlighted.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg bg-muted p-1" role="radiogroup" aria-label="Metrics shown">
            {(
              [
                ["all", "All metrics"],
                ["ltr", "Long-term"],
                ["str", "Short-term"],
              ] as const
            ).map(([value, label]) => (
              <button key={value} type="button" role="radio" aria-checked={filter === value} onClick={() => setFilter(value)} className={cn("rounded-md px-3 py-1 text-sm font-medium", filter === value ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                {label}
              </button>
            ))}
          </div>
          <Button variant="outline" onClick={exportCsv} disabled={!data}>
            <FileSpreadsheet /> Export CSV
          </Button>
          <Button variant="outline" onClick={exportPdf} disabled={!data}>
            <FileDown /> Export PDF
          </Button>
          <Button variant="ghost" onClick={clearCompare}>
            Clear all
          </Button>
        </div>
      </div>

      {query.error ? <Alert tone="error">{errorMessage(query.error)}</Alert> : null}
      {data?.missing.length ? <Alert tone="warning">{data.missing.length} selected propert{data.missing.length === 1 ? "y is" : "ies are"} no longer available and {data.missing.length === 1 ? "was" : "were"} left out.</Alert> : null}
      {data && data.items.length === 1 ? <Alert tone="info">Add at least one more property to compare. Highlights appear when two or more are selected.</Alert> : null}

      {query.isLoading || !hydrated ? (
        <Skeleton className="h-[520px] w-full" />
      ) : data ? (
        <Card className="overflow-hidden">
          <Table data-testid="compare-table">
            <thead>
              <tr>
                <Th className="sticky left-0 z-10 min-w-[190px] bg-muted">Metric</Th>
                {data.items.map(({ context: ctx, analysis }) => (
                  <th key={ctx.id} className="min-w-[210px] border-b bg-card p-3 text-left align-top font-normal">
                    <div className="relative">
                      <PropertyImage id={ctx.id} url={ctx.image_url} type={ctx.property_type} alt={ctx.formatted_address} className="aspect-[16/9] w-full rounded-md" />
                      <button type="button" onClick={() => removeCompare(ctx.id)} aria-label={`Remove ${ctx.formatted_address}`} className="absolute right-1.5 top-1.5 rounded-full bg-card/95 p-1 shadow hover:bg-accent">
                        <X className="size-3.5" />
                      </button>
                      {ctx.is_demo ? <DemoTag className="absolute left-1.5 top-1.5" /> : null}
                    </div>
                    <div className="mt-2 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <Link href={`/properties/${ctx.id}`} className="block truncate text-sm font-semibold hover:underline">
                          {ctx.address_line1 ?? ctx.formatted_address}
                        </Link>
                        <p className="truncate text-xs text-muted-foreground">
                          {ctx.city}, {ctx.state} · {ctx.bedrooms ?? "—"} bd / {ctx.bathrooms ?? "—"} ba
                        </p>
                      </div>
                      <ScoreRing score={analysis.overall_score} size={40} />
                    </div>
                    <div className="mt-2">
                      <RuleBadges badges={analysis.badges} max={2} />
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {metrics.map((metric) => (
                <tr key={metric.key} className="hover:bg-muted/30">
                  <Td className="sticky left-0 z-10 bg-card font-medium">
                    {metric.label}
                    {metric.better !== "none" ? <span className="block text-[10px] font-normal text-muted-foreground">{metric.better === "higher" ? "Higher is better" : "Lower is better"}</span> : null}
                  </Td>
                  {metric.values.map((value, i) => {
                    const best = metric.best_index === i;
                    const negative = typeof value === "number" && value < 0 && ["currency", "percent"].includes(metric.unit);
                    return (
                      <Td key={i} className={cn("tnum", best && "bg-positive-soft font-semibold text-positive", !best && negative && "text-negative", metric.unit === "text" && "text-xs")}>
                        <span className="inline-flex items-center gap-1.5">
                          {best ? <CheckCircle2 className="size-3.5" aria-label="Strongest" /> : null}
                          {metric.key === "confidence" && typeof value === "string" ? <ConfidenceBadge level={value as Confidence} short /> : format(metric, value)}
                        </span>
                      </Td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}
      <p className="text-xs text-muted-foreground">Forecast rows use your growth assumptions and are projections, not guarantees. Ties and missing values are never highlighted.</p>
    </div>
  );
}
