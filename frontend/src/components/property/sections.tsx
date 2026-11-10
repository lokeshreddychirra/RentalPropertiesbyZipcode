"use client";

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Bot, CheckCircle2, CircleHelp, ListChecks, ShieldAlert, Sparkles, TrendingDown, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton, Table, Td, Th } from "@/components/ui/card";
import { Field, Input, NumberInput } from "@/components/ui/form";
import { Hint } from "@/components/ui/overlays";
import { api, errorMessage, type AnalysisBody } from "@/lib/api";
import type {
  AIExplanationResponse,
  Comparable,
  FinancingScenarioResult,
  ForecastResult,
  InvestmentScore,
  PropertyAnalysis,
  QualityAssessment,
  ScenarioResult,
  SensitivityResult,
  Strategy,
  StrategyResult,
} from "@/lib/types";
import { cn, num, pct, ratio, relativeTime, shortDate, signTone, titleCase, usd } from "@/lib/utils";
import { ConfidenceBadge, LegalityBadge, ProvenanceDot, ScoreRing } from "./bits";
import { ExpenseChart, ForecastCashFlowChart, ForecastWealthChart, SERIES, SeasonalityChart } from "./charts";

const STRATEGY_LABEL: Record<Strategy, string> = { ltr: "Long-term rental", str: "Short-term rental" };

export function StrategyToggle({ value, onChange, analysis }: { value: Strategy; onChange: (value: Strategy) => void; analysis: PropertyAnalysis }) {
  return (
    <div className="inline-flex rounded-lg bg-muted p-1" role="radiogroup" aria-label="Strategy">
      {(["ltr", "str"] as const).map((key) => {
        const available = key === "ltr" ? analysis.long_term.available : analysis.short_term.available;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={value === key}
            onClick={() => onChange(key)}
            className={cn("inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium transition-colors", value === key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
          >
            <span className="size-2 rounded-full" style={{ backgroundColor: SERIES[key] }} aria-hidden />
            {key === "ltr" ? "Long-term" : "Short-term"}
            {!available ? <span className="text-[10px] font-normal">(no data)</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function Unavailable({ result }: { result: StrategyResult }) {
  return (
    <Alert tone="warning" title={`${STRATEGY_LABEL[result.strategy]} cannot be calculated yet`}>
      {result.unavailable_reason}
    </Alert>
  );
}

// ----------------------------------------------------------------------------- recommendation + headline

export function RecommendationCard({ analysis }: { analysis: PropertyAnalysis }) {
  const rec = analysis.recommendation;
  const tone = rec.strategy === null ? "warning" : rec.conditional ? "warning" : "success";
  return (
    <Alert tone={tone} title={rec.strategy ? `Financially stronger strategy: ${rec.headline}` : rec.headline}>
      <ul className="list-disc space-y-0.5 pl-4">
        {rec.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      <p className="mt-1.5 text-xs opacity-80">Based on your current assumptions. This is a comparison of estimates, not a prediction.</p>
    </Alert>
  );
}

export function HeadlineMetrics({ analysis }: { analysis: PropertyAnalysis }) {
  const columns: { key: Strategy; result: StrategyResult; score: InvestmentScore; quality: QualityAssessment }[] = [
    { key: "ltr", result: analysis.long_term, score: analysis.score_ltr, quality: analysis.quality_ltr },
    { key: "str", result: analysis.short_term, score: analysis.score_str, quality: analysis.quality_str },
  ];
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {columns.map(({ key, result, score, quality }) => (
        <Card key={key} className={cn(analysis.primary_strategy === key && "ring-1 ring-[hsl(var(--ring))]")}>
          <CardHeader className="flex-row items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <span className="size-2.5 rounded-full" style={{ backgroundColor: SERIES[key] }} aria-hidden />
                {STRATEGY_LABEL[key]}
                {analysis.primary_strategy === key ? <Badge tone="solid">Recommended{analysis.recommendation.conditional ? "*" : ""}</Badge> : null}
              </CardTitle>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <ConfidenceBadge level={quality.label} />
                {key === "str" ? <LegalityBadge status={analysis.legality.status} label={analysis.legality.label} /> : null}
              </div>
            </div>
            <ScoreRing score={score.score} size={56} />
          </CardHeader>
          <CardContent>
            {result.available ? (
              <dl className="grid grid-cols-3 gap-x-3 gap-y-3">
                {[
                  ["Monthly cash flow", `${usd(result.monthly_cash_flow)}`, signTone(result.monthly_cash_flow)],
                  ["Cash-on-cash", pct(result.cash_on_cash_pct, 2), signTone(result.cash_on_cash_pct)],
                  ["Cap rate", pct(result.cap_rate_pct, 2), ""],
                  ["Gross yield", pct(result.gross_yield_pct, 2), ""],
                  ["DSCR", result.dscr != null ? ratio(result.dscr) : "N/A", ""],
                  ["Upfront cash", usd(result.total_cash_invested), ""],
                ].map(([label, value, tone]) => (
                  <div key={label}>
                    <dt className="text-[11px] text-muted-foreground">{label}</dt>
                    <dd className={cn("tnum text-base font-semibold", tone)}>{value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <Unavailable result={result} />
            )}
            {score.cap_applied ? (
              <p className="mt-3 flex items-start gap-1.5 text-xs text-caution">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {score.cap_applied}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------------------- side-by-side comparison

export function StrategyComparisonTable({ analysis }: { analysis: PropertyAnalysis }) {
  const { long_term: l, short_term: s } = analysis;
  type Row = { label: string; hint?: string; ltr: React.ReactNode; str: React.ReactNode; better?: "higher" | "lower"; lv?: number | null; sv?: number | null; group?: string };
  const m = (r: StrategyResult, value: number | null | undefined, fmt: (v: number | null | undefined) => string) => (r.available ? fmt(value) : "—");
  const rows: Row[] = [
    { group: "Gross", label: "Gross annual revenue", ltr: m(l, l.gross_annual_income, usd), str: m(s, s.gross_annual_income, usd), better: "higher", lv: l.gross_annual_income, sv: s.gross_annual_income },
    { label: "Gross yield", hint: "Annual gross rental income ÷ purchase price", ltr: m(l, l.gross_yield_pct, (v) => pct(v, 2)), str: m(s, s.gross_yield_pct, (v) => pct(v, 2)), better: "higher", lv: l.gross_yield_pct, sv: s.gross_yield_pct },
    { group: "Operating (before financing)", label: "Vacancy loss", ltr: m(l, l.vacancy_loss, usd), str: s.available ? "In occupancy rate" : "—" },
    { label: "Operating expenses", hint: "Excludes mortgage payments, depreciation and income taxes", ltr: m(l, l.operating_expenses_annual, usd), str: m(s, s.operating_expenses_annual, usd), better: "lower", lv: l.operating_expenses_annual, sv: s.operating_expenses_annual },
    { label: "Net operating income (NOI)", hint: "Effective gross income − operating expenses", ltr: m(l, l.noi_annual, usd), str: m(s, s.noi_annual, usd), better: "higher", lv: l.noi_annual, sv: s.noi_annual },
    { label: "Cap rate", hint: "NOI ÷ purchase price", ltr: m(l, l.cap_rate_pct, (v) => pct(v, 2)), str: m(s, s.cap_rate_pct, (v) => pct(v, 2)), better: "higher", lv: l.cap_rate_pct, sv: s.cap_rate_pct },
    { label: "Net yield", hint: "NOI ÷ total acquisition basis (price + closing, renovation, furnishing…)", ltr: m(l, l.net_yield_pct, (v) => pct(v, 2)), str: m(s, s.net_yield_pct, (v) => pct(v, 2)), better: "higher", lv: l.net_yield_pct, sv: s.net_yield_pct },
    { group: "Leveraged (after financing)", label: "Annual debt service", hint: "Principal + interest + PMI", ltr: m(l, l.annual_debt_service, usd), str: m(s, s.annual_debt_service, usd) },
    { label: "Monthly cash flow", hint: "(NOI − debt service) ÷ 12", ltr: m(l, l.monthly_cash_flow, usd), str: m(s, s.monthly_cash_flow, usd), better: "higher", lv: l.monthly_cash_flow, sv: s.monthly_cash_flow },
    { label: "Cash-on-cash return", hint: "Annual pre-tax cash flow ÷ total cash invested", ltr: m(l, l.cash_on_cash_pct, (v) => pct(v, 2)), str: m(s, s.cash_on_cash_pct, (v) => pct(v, 2)), better: "higher", lv: l.cash_on_cash_pct, sv: s.cash_on_cash_pct },
    { label: "DSCR", hint: "NOI ÷ annual debt service. Not applicable to cash purchases.", ltr: l.available ? (l.dscr != null ? ratio(l.dscr) : "N/A") : "—", str: s.available ? (s.dscr != null ? ratio(s.dscr) : "N/A") : "—", better: "higher", lv: l.dscr, sv: s.dscr },
    { label: "Initial cash required", ltr: m(l, l.total_cash_invested, usd), str: m(s, s.total_cash_invested, usd), better: "lower", lv: l.total_cash_invested, sv: s.total_cash_invested },
    { label: "Break-even occupancy", hint: "Occupancy needed to cover operating costs and financing", ltr: m(l, l.break_even_occupancy_pct, (v) => pct(v, 1)), str: m(s, s.break_even_occupancy_pct, (v) => pct(v, 1)), better: "lower", lv: l.break_even_occupancy_pct, sv: s.break_even_occupancy_pct },
    { group: "Risk", label: "Regulatory risk", ltr: analysis.recommendation.regulatory_risk_ltr, str: analysis.recommendation.regulatory_risk_str || "—" },
    { label: "Investment score", ltr: analysis.score_ltr.score != null ? analysis.score_ltr.score.toFixed(0) : "Unranked", str: analysis.score_str.score != null ? analysis.score_str.score.toFixed(0) : "Unranked", better: "higher", lv: analysis.score_ltr.score, sv: analysis.score_str.score },
  ];
  const winner = (row: Row): Strategy | null => {
    if (!row.better || !l.available || !s.available || row.lv == null || row.sv == null || row.lv === row.sv) return null;
    return (row.better === "higher" ? row.lv > row.sv : row.lv < row.sv) ? "ltr" : "str";
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Long-term vs short-term rental</CardTitle>
        <CardDescription>Both strategies are calculated independently with the same purchase and financing assumptions. The stronger value on each row is marked.</CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <Table data-testid="strategy-comparison">
          <thead>
            <tr>
              <Th className="pl-5">Metric</Th>
              <Th className="text-right">
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-full" style={{ backgroundColor: SERIES.ltr }} aria-hidden /> Long-term rental
                </span>
              </Th>
              <Th className="pr-5 text-right">
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-full" style={{ backgroundColor: SERIES.str }} aria-hidden /> Short-term rental
                </span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const best = winner(row);
              const cell = (key: Strategy, content: React.ReactNode) => (
                <Td className={cn("tnum text-right", key === "str" && "pr-5", row.group === "Risk" && row.label === "Regulatory risk" && "max-w-[240px] whitespace-normal text-left text-xs font-normal text-muted-foreground sm:text-right", best === key && "font-semibold")}>
                  <span className="inline-flex items-center justify-end gap-1.5">
                    {best === key ? <CheckCircle2 className="size-3.5 text-positive" aria-label="Stronger" /> : null}
                    {content}
                  </span>
                </Td>
              );
              return (
                <React.Fragment key={row.label}>
                  {row.group ? (
                    <tr>
                      <td colSpan={3} className="border-b bg-muted/30 px-5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {row.group}
                      </td>
                    </tr>
                  ) : null}
                  <tr>
                    <Td className="pl-5">
                      {row.hint ? (
                        <Hint content={row.hint}>
                          <span className="underline decoration-dotted underline-offset-2" tabIndex={0}>
                            {row.label}
                          </span>
                        </Hint>
                      ) : (
                        row.label
                      )}
                    </Td>
                    {cell("ltr", row.ltr)}
                    {cell("str", row.str)}
                  </tr>
                </React.Fragment>
              );
            })}
          </tbody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ----------------------------------------------------------------------------- financial model per strategy

export function FinancialModel({ analysis, strategy }: { analysis: PropertyAnalysis; strategy: Strategy }) {
  const result = strategy === "ltr" ? analysis.long_term : analysis.short_term;
  if (!result.available) return <Unavailable result={result} />;
  const detail = result.str_detail;
  const statement: [string, number | null | undefined, string?][] = [
    ...(detail
      ? ([
          ["Accommodation revenue", detail.accommodation_revenue],
          ["Cleaning fees collected", detail.cleaning_fee_revenue],
        ] as [string, number][])
      : ([["Gross scheduled rent & other income", result.gross_annual_income]] as [string, number | null | undefined][])),
    ...(result.vacancy_loss ? ([["Vacancy loss", -result.vacancy_loss]] as [string, number][]) : []),
    ["Effective gross income", result.effective_gross_income, "total"],
    ["Operating expenses", -(result.operating_expenses_annual ?? 0)],
    ["Net operating income", result.noi_annual, "total"],
    ["Debt service", -(result.annual_debt_service ?? 0)],
    ["Pre-tax cash flow", result.annual_cash_flow, "total"],
  ];
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Annual income statement</CardTitle>
          <CardDescription>Year one, {STRATEGY_LABEL[strategy].toLowerCase()}. NOI excludes mortgage payments, depreciation and income tax.</CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table>
            <thead>
              <tr>
                <Th className="pl-5">Line</Th>
                <Th className="text-right">Annual</Th>
                <Th className="pr-5 text-right">Monthly</Th>
              </tr>
            </thead>
            <tbody>
              {statement.map(([label, value, kind]) => (
                <tr key={label} className={cn(kind === "total" && "bg-muted/30 font-semibold")}>
                  <Td className="pl-5">{label}</Td>
                  <Td className={cn("tnum text-right", kind === "total" && label === "Pre-tax cash flow" && signTone(value))}>{usd(value)}</Td>
                  <Td className={cn("tnum pr-5 text-right", kind === "total" && label === "Pre-tax cash flow" && signTone(value))}>{usd(value == null ? null : value / 12)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {result.break_even_note ? (
            <p className="flex items-start gap-1.5 px-5 py-3 text-xs text-caution">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {result.break_even_note}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Operating expense breakdown</CardTitle>
          <CardDescription>
            {usd(result.operating_expenses_annual)} per year · {pct(result.expense_ratio_pct)} of effective gross income
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ExpenseChart result={result} color={SERIES[strategy]} />
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">View as table</summary>
            <Table className="mt-2">
              <thead>
                <tr>
                  <Th>Expense</Th>
                  <Th className="text-right">Annual</Th>
                  <Th className="text-right">Monthly</Th>
                  <Th>Behaviour</Th>
                </tr>
              </thead>
              <tbody>
                {result.expenses?.map((line) => (
                  <tr key={line.key}>
                    <Td>{line.label}</Td>
                    <Td className="tnum text-right">{usd(line.annual)}</Td>
                    <Td className="tnum text-right">{usd(line.monthly)}</Td>
                    <Td className="text-xs text-muted-foreground">{line.behavior === "fixed" ? "Fixed" : "Varies with bookings / rent"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </details>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cash required to close</CardTitle>
          <CardDescription>Total upfront investment used for cash-on-cash return.</CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table>
            <tbody>
              {result.cash_breakdown?.filter((line) => line.amount > 0 || line.key === "down_payment").map((line) => (
                <tr key={line.key}>
                  <Td className="pl-5">{line.label}</Td>
                  <Td className="tnum pr-5 text-right">{usd(line.amount)}</Td>
                </tr>
              ))}
              <tr className="bg-muted/30 font-semibold">
                <Td className="pl-5">Total initial investment</Td>
                <Td className="tnum pr-5 text-right">{usd(result.total_cash_invested)}</Td>
              </tr>
            </tbody>
          </Table>
        </CardContent>
      </Card>

      <MortgageCard analysis={analysis} />

      {detail ? (
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Short-term rental operations</CardTitle>
            <CardDescription>
              Accommodation revenue = average daily rate × booked nights. Booked nights = available nights × occupancy{detail.nights_capped_by_regulation ? ", limited by the legal night cap" : ""}.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 self-start">
              {[
                ["Average daily rate", usd(detail.adr, { cents: true })],
                ["Occupancy (available nights)", pct(detail.available_occupancy_pct)],
                ["Occupancy (calendar nights)", pct(detail.calendar_occupancy_pct)],
                ["Nights available / yr", num(detail.available_nights)],
                ["Nights booked / yr", num(detail.booked_nights, 0)],
                ["Guest stays / yr", num(detail.turnovers, 0)],
                ["RevPAR (per calendar night)", usd(detail.revpar, { cents: true })],
                ["Cleaning fees collected", usd(detail.cleaning_fee_revenue)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-[11px] text-muted-foreground">{label}</dt>
                  <dd className="tnum text-sm font-semibold">{value}</dd>
                </div>
              ))}
            </dl>
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Projected gross revenue by month (seasonality)</p>
              <SeasonalityChart result={result} />
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

export function MortgageCard({ analysis }: { analysis: PropertyAnalysis }) {
  const loan = analysis.loan;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Mortgage</CardTitle>
        <CardDescription>{loan.is_cash ? "All-cash purchase — no debt service." : `${loan.loan_term_years}-year fixed at ${loan.interest_rate_pct}% with standard amortization.`}</CardDescription>
      </CardHeader>
      <CardContent>
        {loan.is_cash ? (
          <p className="text-sm text-muted-foreground">DSCR is not applicable and cash-on-cash return equals the unleveraged return on cash invested.</p>
        ) : (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            {[
              ["Loan amount", usd(loan.loan_amount)],
              ["Down payment", usd(loan.down_payment)],
              ["Principal & interest / mo", usd(loan.monthly_principal_interest, { cents: true })],
              ["PMI / mo", loan.monthly_pmi > 0 ? `${usd(loan.monthly_pmi, { cents: true })} for ${loan.pmi_months} months` : "Not required"],
              ["Debt service, year 1", usd(loan.annual_debt_service)],
              ["Year-1 interest / principal", `${usd(loan.first_year_interest)} / ${usd(loan.first_year_principal)}`],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-[11px] text-muted-foreground">{label}</dt>
                <dd className="tnum text-sm font-semibold">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

// ----------------------------------------------------------------------------- forecast

const HORIZONS = [1, 5, 10, 15, 30];

export function ForecastSection({ analysis, strategy }: { analysis: PropertyAnalysis; strategy: Strategy }) {
  const [years, setYears] = React.useState(10);
  const forecast: ForecastResult | null | undefined = strategy === "ltr" ? analysis.forecast_ltr : analysis.forecast_str;
  const result = strategy === "ltr" ? analysis.long_term : analysis.short_term;
  if (!result.available) return <Unavailable result={result} />;
  if (!forecast?.available) return <Skeleton className="h-80 w-full" />;
  const fc = analysis.assumptions.forecast;
  return (
    <div className="space-y-4">
      <Alert tone="warning" title="Projection, not a guarantee">
        Assumes rent growth of {fc.rent_growth_pct}%/yr, appreciation of {fc.appreciation_pct}%/yr, expense inflation of {fc.expense_inflation_pct}%/yr and selling costs of{" "}
        {fc.selling_cost_pct}% — all constant, and all editable under “Growth &amp; exit”. Actual results will differ.
      </Alert>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Horizon</span>
        <div className="inline-flex rounded-lg bg-muted p-1" role="radiogroup" aria-label="Forecast horizon">
          {HORIZONS.map((h) => (
            <button key={h} type="button" role="radio" aria-checked={years === h} onClick={() => setYears(h)} className={cn("tnum rounded-md px-2.5 py-1 text-sm font-medium", years === h ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground")}>
              {h} yr
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Equity, debt and cumulative cash flow</CardTitle>
            <CardDescription>Equity = estimated value − loan balance. Appreciation is shown separately from operating cash flow.</CardDescription>
          </CardHeader>
          <CardContent>{years > 1 ? <ForecastWealthChart forecast={forecast} years={years} /> : <p className="text-sm text-muted-foreground">Choose a longer horizon to chart the trend. Year-one figures are in the table below.</p>}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Annual pre-tax cash flow</CardTitle>
            <CardDescription>After operating expenses, debt service and planned capital improvements. Lighter bars are negative years.</CardDescription>
          </CardHeader>
          <CardContent>
            <ForecastCashFlowChart forecast={forecast} years={Math.max(years, 2)} color={SERIES[strategy]} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>If sold at the end of…</CardTitle>
          <CardDescription>
            Total investor return = cumulative cash flow + net sale proceeds + released reserves − {usd(forecast.initial_cash_invested)} initial cash invested.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table data-testid="forecast-horizons">
            <thead>
              <tr>
                <Th className="pl-5">Horizon</Th>
                <Th className="text-right">Cumulative cash flow</Th>
                <Th className="text-right">Principal reduction</Th>
                <Th className="text-right">Appreciation</Th>
                <Th className="text-right">Loan balance</Th>
                <Th className="text-right">Estimated equity</Th>
                <Th className="text-right">Net sale proceeds</Th>
                <Th className="text-right">Total return</Th>
                <Th className="pr-5 text-right">IRR</Th>
              </tr>
            </thead>
            <tbody>
              {forecast.horizons.map((h) => (
                <tr key={h.years} className={cn(h.years === years && "bg-muted/40")}>
                  <Td className="pl-5 font-medium">
                    {h.years} year{h.years > 1 ? "s" : ""}
                  </Td>
                  <Td className={cn("tnum text-right", signTone(h.cumulative_cash_flow))}>{usd(h.cumulative_cash_flow)}</Td>
                  <Td className="tnum text-right">{usd(h.principal_reduction)}</Td>
                  <Td className="tnum text-right">{usd(h.appreciation)}</Td>
                  <Td className="tnum text-right">{usd(h.loan_balance)}</Td>
                  <Td className="tnum text-right">{usd(h.equity)}</Td>
                  <Td className="tnum text-right">{usd(h.net_sale_proceeds)}</Td>
                  <Td className={cn("tnum text-right font-semibold", signTone(h.total_profit))}>
                    {usd(h.total_profit)} <span className="font-normal text-muted-foreground">({pct(h.total_return_pct, 0)})</span>
                  </Td>
                  <Td className="tnum pr-5 text-right">{h.irr_pct != null ? pct(h.irr_pct, 1) : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </CardContent>
      </Card>

      <details className="rounded-lg border bg-card">
        <summary className="cursor-pointer px-5 py-3 text-sm font-medium">Year-by-year projection table</summary>
        <Table>
          <thead>
            <tr>
              <Th className="pl-5">Year</Th>
              <Th className="text-right">Gross income</Th>
              <Th className="text-right">Operating expenses</Th>
              <Th className="text-right">NOI</Th>
              <Th className="text-right">Debt service</Th>
              <Th className="text-right">Cash flow</Th>
              <Th className="text-right">Cumulative</Th>
              <Th className="text-right">Principal paid</Th>
              <Th className="text-right">Loan balance</Th>
              <Th className="pr-5 text-right">Value</Th>
            </tr>
          </thead>
          <tbody>
            {forecast.years.filter((y) => y.year <= Math.max(years, 5)).map((y) => (
              <tr key={y.year}>
                <Td className="tnum pl-5">{y.year}</Td>
                <Td className="tnum text-right">{usd(y.gross_income)}</Td>
                <Td className="tnum text-right">{usd(y.operating_expenses)}</Td>
                <Td className="tnum text-right">{usd(y.noi)}</Td>
                <Td className="tnum text-right">{usd(y.debt_service)}</Td>
                <Td className={cn("tnum text-right", signTone(y.cash_flow))}>{usd(y.cash_flow)}</Td>
                <Td className={cn("tnum text-right", signTone(y.cumulative_cash_flow))}>{usd(y.cumulative_cash_flow)}</Td>
                <Td className="tnum text-right">{usd(y.principal_paid)}</Td>
                <Td className="tnum text-right">{usd(y.loan_balance)}</Td>
                <Td className="tnum pr-5 text-right">{usd(y.property_value)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </details>
    </div>
  );
}

// ----------------------------------------------------------------------------- financing scenarios

export interface CustomLoan {
  name: string;
  down_payment_pct: number;
  interest_rate_pct: number;
  loan_term_years: number;
}

export function FinancingSection({ analysis, strategy, custom, onCustomChange }: { analysis: PropertyAnalysis; strategy: Strategy; custom: CustomLoan[]; onCustomChange: (next: CustomLoan[]) => void }) {
  const [draft, setDraft] = React.useState<CustomLoan>({ name: "Investor loan", down_payment_pct: 35, interest_rate_pct: 7.75, loan_term_years: 30 });
  const rows: FinancingScenarioResult[] = analysis.financing ?? [];
  if (!rows.length) return <Skeleton className="h-64 w-full" />;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Financing scenarios</CardTitle>
          <CardDescription>
            How the loan structure changes upfront cash, payments and returns for the {STRATEGY_LABEL[strategy].toLowerCase()}. Presets use your interest rate; the 15-year option
            assumes a 0.6-point lower rate.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table data-testid="financing-table">
            <thead>
              <tr>
                <Th className="pl-5">Scenario</Th>
                <Th className="text-right">Rate</Th>
                <Th className="text-right">Upfront cash</Th>
                <Th className="text-right">Mortgage / mo</Th>
                <Th className="text-right">Cash flow / mo</Th>
                <Th className="text-right">Cash-on-cash</Th>
                <Th className="text-right">DSCR</Th>
                <Th className="text-right">10-yr total return</Th>
                <Th className="text-right">10-yr IRR</Th>
                <Th className="pr-5 text-right">30-yr total return</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const r = strategy === "ltr" ? row.long_term : row.short_term;
                const ten = strategy === "ltr" ? row.ltr_ten_year_profit : row.str_ten_year_profit;
                const irr = strategy === "ltr" ? row.ltr_ten_year_irr_pct : row.str_ten_year_irr_pct;
                const thirty = strategy === "ltr" ? row.ltr_thirty_year_profit : row.str_thirty_year_profit;
                return (
                  <tr key={row.key} className={cn(row.key === "current" && "bg-muted/40")}>
                    <Td className="pl-5 font-medium">
                      {row.label}
                      {row.key === "current" ? <span className="block text-[11px] font-normal text-muted-foreground">{row.is_cash ? "All cash" : `${row.down_payment_pct}% down · ${row.loan_term_years}-year`}</span> : null}
                      {row.key.startsWith("custom_") ? (
                        <button type="button" className="block text-[11px] font-normal text-muted-foreground underline" onClick={() => onCustomChange(custom.filter((_, i) => `custom_${i}` !== row.key))}>
                          Remove
                        </button>
                      ) : null}
                    </Td>
                    <Td className="tnum text-right">{row.is_cash ? "—" : pct(row.interest_rate_pct, 2)}</Td>
                    <Td className="tnum text-right">{usd(r.available ? r.total_cash_invested : row.upfront_cash)}</Td>
                    <Td className="tnum text-right">{row.is_cash ? "—" : usd(row.monthly_payment)}</Td>
                    <Td className={cn("tnum text-right font-medium", signTone(r.monthly_cash_flow))}>{r.available ? usd(r.monthly_cash_flow) : "—"}</Td>
                    <Td className={cn("tnum text-right", signTone(r.cash_on_cash_pct))}>{r.available ? pct(r.cash_on_cash_pct, 2) : "—"}</Td>
                    <Td className="tnum text-right">{r.available ? (r.dscr != null ? ratio(r.dscr) : "N/A") : "—"}</Td>
                    <Td className={cn("tnum text-right", signTone(ten))}>{usd(ten)}</Td>
                    <Td className="tnum text-right">{irr != null ? pct(irr, 1) : "—"}</Td>
                    <Td className={cn("tnum pr-5 text-right", signTone(thirty))}>{usd(thirty)}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add a custom financing scenario</CardTitle>
          <CardDescription>For example a DSCR or portfolio loan with different terms.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid grid-cols-2 items-end gap-3 md:grid-cols-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (custom.length >= 5) return;
              onCustomChange([...custom, { ...draft, name: draft.name.trim() || "Custom loan" }]);
            }}
          >
            <Field label="Name" htmlFor="cl-name" className="col-span-2 md:col-span-1">
              <Input id="cl-name" value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label="Down payment" htmlFor="cl-down">
              <NumberInput id="cl-down" suffix="%" value={draft.down_payment_pct} onValueChange={(v) => v !== null && setDraft({ ...draft, down_payment_pct: Math.min(Math.max(v, 0), 100) })} />
            </Field>
            <Field label="Interest rate" htmlFor="cl-rate">
              <NumberInput id="cl-rate" suffix="%" value={draft.interest_rate_pct} onValueChange={(v) => v !== null && setDraft({ ...draft, interest_rate_pct: Math.min(Math.max(v, 0), 30) })} />
            </Field>
            <Field label="Term" htmlFor="cl-term">
              <NumberInput id="cl-term" suffix="yr" value={draft.loan_term_years} onValueChange={(v) => v !== null && setDraft({ ...draft, loan_term_years: Math.min(Math.max(Math.round(v), 1), 40) })} />
            </Field>
            <Button type="submit" variant="outline" disabled={custom.length >= 5}>
              Add scenario
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

// ----------------------------------------------------------------------------- scenarios + sensitivity

const SCENARIO_META = {
  conservative: { label: "Conservative", Icon: TrendingDown },
  base: { label: "Base case", Icon: CircleHelp },
  optimistic: { label: "Optimistic", Icon: TrendingUp },
} as const;

export function ScenarioSection({ analysis, strategy }: { analysis: PropertyAnalysis; strategy: Strategy }) {
  const scenarios: ScenarioResult[] | null | undefined = strategy === "ltr" ? analysis.scenarios_ltr : analysis.scenarios_str;
  const sensitivity: SensitivityResult | null | undefined = strategy === "ltr" ? analysis.sensitivity_ltr : analysis.sensitivity_str;
  const result = strategy === "ltr" ? analysis.long_term : analysis.short_term;
  if (!result.available) return <Unavailable result={result} />;
  if (!scenarios || !sensitivity) return <Skeleton className="h-80 w-full" />;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        {scenarios.map((scenario) => {
          const meta = SCENARIO_META[scenario.name];
          const r = scenario.result;
          return (
            <Card key={scenario.name} className={cn(scenario.name === "base" && "ring-1 ring-[hsl(var(--ring))]")}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <meta.Icon className="size-4 text-muted-foreground" aria-hidden /> {meta.label}
                </CardTitle>
                <CardDescription>{scenario.changes.join(" · ")}</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-3">
                  {[
                    ["NOI / yr", usd(r.noi_annual), ""],
                    ["Cash flow / mo", usd(r.monthly_cash_flow), signTone(r.monthly_cash_flow)],
                    ["Cap rate", pct(r.cap_rate_pct, 2), ""],
                    ["Cash-on-cash", pct(r.cash_on_cash_pct, 2), signTone(r.cash_on_cash_pct)],
                    ["DSCR", r.dscr != null ? ratio(r.dscr) : "N/A", ""],
                    ["10-yr total return", usd(scenario.ten_year_total_profit), signTone(scenario.ten_year_total_profit)],
                  ].map(([label, value, tone]) => (
                    <div key={label}>
                      <dt className="text-[11px] text-muted-foreground">{label}</dt>
                      <dd className={cn("tnum text-sm font-semibold", tone)}>{value}</dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {sensitivity.tables.map((table) => (
          <Card key={table.variable}>
            <CardHeader>
              <CardTitle>Sensitivity: {table.label.toLowerCase()}</CardTitle>
              <CardDescription>Everything else held at your current assumptions.</CardDescription>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              <Table>
                <thead>
                  <tr>
                    <Th className="pl-5">Change</Th>
                    <Th className="text-right">{table.label}</Th>
                    <Th className="text-right">Cash flow / mo</Th>
                    <Th className="text-right">Cash-on-cash</Th>
                    <Th className="text-right">Cap rate</Th>
                    <Th className="pr-5 text-right">DSCR</Th>
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row) => (
                    <tr key={row.label} className={cn(row.is_base && "bg-muted/40 font-semibold")}>
                      <Td className="pl-5">{row.label}</Td>
                      <Td className="tnum text-right">{table.unit === "currency" ? usd(row.input_value) : pct(row.input_value, 2)}</Td>
                      <Td className={cn("tnum text-right", signTone(row.monthly_cash_flow))}>{usd(row.monthly_cash_flow)}</Td>
                      <Td className={cn("tnum text-right", signTone(row.cash_on_cash_pct))}>{pct(row.cash_on_cash_pct, 2)}</Td>
                      <Td className="tnum text-right">{pct(row.cap_rate_pct, 2)}</Td>
                      <Td className="tnum pr-5 text-right">{row.dscr != null ? ratio(row.dscr) : "N/A"}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </CardContent>
          </Card>
        ))}
      </div>

      {sensitivity.price_rate_grid ? (
        <Card>
          <CardHeader>
            <CardTitle>Monthly cash flow by purchase price and interest rate</CardTitle>
            <CardDescription>Rows are purchase prices; columns are mortgage rates. The outlined cell is your current assumption.</CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <Table>
              <thead>
                <tr>
                  <Th className="pl-5">Price ↓ / Rate →</Th>
                  {sensitivity.price_rate_grid.columns.map((rate) => (
                    <Th key={rate} className="text-right">
                      {pct(rate, 2)}
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sensitivity.price_rate_grid.rows.map((price, i) => (
                  <tr key={price}>
                    <Td className="tnum pl-5 font-medium">{usd(price)}</Td>
                    {sensitivity.price_rate_grid!.values[i].map((value, j) => (
                      <Td key={j} className={cn("tnum text-right", signTone(value), i === 2 && j === 2 && "font-semibold outline outline-2 -outline-offset-2 outline-[hsl(var(--ring))]")}>
                        {usd(value)}
                      </Td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

// ----------------------------------------------------------------------------- risk & data quality

function QualityCard({ quality, title }: { quality: QualityAssessment; title: string }) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>Data-quality score {quality.score}/100. High ≥ 75 · Medium ≥ 55 · Low ≥ 35.</CardDescription>
        </div>
        <ConfidenceBadge level={quality.label} />
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-2.5">
          {quality.factors.map((factor) => (
            <li key={factor.key}>
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <ProvenanceDot source={factor.provenance} /> {factor.label}
                </span>
                <span className="tnum text-xs text-muted-foreground">
                  {factor.points}/{factor.max_points}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary/70" style={{ width: `${(factor.points / factor.max_points) * 100}%` }} />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{factor.detail}</p>
            </li>
          ))}
        </ul>
        {quality.caveats.length ? (
          <Alert tone="warning" title="Verify before relying on this">
            <ul className="list-disc space-y-0.5 pl-4">
              {quality.caveats.map((caveat) => (
                <li key={caveat}>{caveat}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ScoreBreakdown({ score, title }: { score: InvestmentScore; title: string }) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>Each component is normalised to 0–100 on a fixed scale, then weighted. Weights are editable in Settings.</CardDescription>
        </div>
        <ScoreRing score={score.score} size={52} />
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {score.components.length ? (
          <Table>
            <thead>
              <tr>
                <Th className="pl-5">Component</Th>
                <Th>Value</Th>
                <Th className="text-right">Weight</Th>
                <Th className="text-right">Normalised</Th>
                <Th className="pr-5 text-right">Points</Th>
              </tr>
            </thead>
            <tbody>
              {score.components.map((component) => (
                <tr key={component.key}>
                  <Td className="pl-5 font-medium">{component.label}</Td>
                  <Td className="max-w-[220px] text-xs text-muted-foreground">{component.detail}</Td>
                  <Td className="tnum text-right">{component.weight_pct.toFixed(0)}%</Td>
                  <Td className="tnum text-right">{component.normalized.toFixed(0)}</Td>
                  <Td className="tnum pr-5 text-right font-medium">{component.contribution.toFixed(1)}</Td>
                </tr>
              ))}
              <tr className="bg-muted/30 font-semibold">
                <Td className="pl-5" colSpan={4}>
                  {score.cap_applied ? `Weighted total ${score.uncapped_score?.toFixed(1)} → ${score.cap_applied}` : "Investment score"}
                </Td>
                <Td className="tnum pr-5 text-right">{score.score?.toFixed(1) ?? "—"}</Td>
              </tr>
            </tbody>
          </Table>
        ) : (
          <p className="px-5 pb-5 text-sm text-muted-foreground">Not ranked — this strategy has no income estimate.</p>
        )}
      </CardContent>
    </Card>
  );
}

export function RiskSection({ analysis }: { analysis: PropertyAnalysis }) {
  const legality = analysis.legality;
  const tone = legality.status === "permitted" ? "success" : legality.status === "prohibited" ? "error" : "warning";
  return (
    <div className="space-y-4">
      <Alert tone={tone} title={`Short-term rental legality: ${legality.label}`}>
        {legality.verified ? (
          <>
            {legality.summary ?? `Recorded as ${legality.status}.`}
            {legality.jurisdiction ? ` Jurisdiction: ${legality.jurisdiction}.` : ""}
            {legality.verified_at ? ` Verified ${shortDate(legality.verified_at)}.` : ""}
            {legality.max_nights_per_year != null ? ` Night cap: ${legality.max_nights_per_year} per year.` : ""}{" "}
            {legality.source_url ? (
              <a href={legality.source_url} target="_blank" rel="noopener noreferrer">
                Source
              </a>
            ) : null}
          </>
        ) : (
          "Local short-term rental rules have not been verified for this location. Nearby Airbnb listings are not evidence that operating one is legal — check zoning, permit, tax and HOA rules before relying on short-term income."
        )}
      </Alert>
      <div className="grid gap-4 xl:grid-cols-2">
        <QualityCard quality={analysis.quality_ltr} title="Long-term rental data quality" />
        <QualityCard quality={analysis.quality_str} title="Short-term rental data quality" />
        <ScoreBreakdown score={analysis.score_ltr} title="Long-term investment score" />
        <ScoreBreakdown score={analysis.score_str} title="Short-term investment score" />
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------- AI analyst

export function AISection({ body, analysisKey }: { body: AnalysisBody; analysisKey: string }) {
  const mutation = useMutation<AIExplanationResponse, Error, void>({ mutationFn: () => api.aiExplanation(body) });
  const [generatedFor, setGeneratedFor] = React.useState<string | null>(null);
  const stale = generatedFor !== null && generatedFor !== analysisKey;
  const data = mutation.data;
  const explanation = data?.explanation;
  const list = (title: string, items: string[], Icon: React.ComponentType<{ className?: string }>, tone: string) => (
    <div>
      <h4 className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold">
        <Icon className={cn("size-4", tone)} aria-hidden /> {title}
      </h4>
      <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Bot className="size-4" aria-hidden /> AI investment analyst
          </CardTitle>
          <CardDescription>
            Explains the calculated results in plain language. It only sees values produced by the financial engine and sourced listing data, and any response quoting a figure
            that cannot be traced to them is rejected.
          </CardDescription>
        </div>
        <Button
          onClick={() =>
            mutation.mutate(undefined, {
              onSuccess: () => setGeneratedFor(analysisKey),
            })
          }
          disabled={mutation.isPending}
        >
          <Sparkles /> {mutation.isPending ? "Analysing…" : data ? "Regenerate" : "Generate analysis"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {mutation.isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        ) : null}
        {mutation.error ? <Alert tone="error">{errorMessage(mutation.error)}</Alert> : null}
        {!data && !mutation.isPending && !mutation.error ? <p className="text-sm text-muted-foreground">Generate an explanation of this property under your current assumptions.</p> : null}
        {explanation && !mutation.isPending ? (
          <div className="space-y-4" data-testid="ai-explanation">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={data.engine === "llm" ? "solid" : "outline"}>{data.engine === "llm" ? `AI model: ${data.model}` : "Rule-based summary"}</Badge>
              <Badge tone="positive">
                <CheckCircle2 className="size-3" aria-hidden /> Grounded in calculated values
              </Badge>
              {data.is_demo ? <Badge tone="demo">Demo data</Badge> : null}
            </div>
            {stale ? <Alert tone="warning">Assumptions have changed since this was generated. Regenerate to refresh it.</Alert> : null}
            {data.note ? <Alert tone="info">{data.note}</Alert> : null}
            <p className="text-[15px] leading-relaxed">{explanation.summary}</p>
            <div className="grid gap-5 md:grid-cols-2">
              {list("Why it may be attractive", explanation.attractive_points, TrendingUp, "text-positive")}
              {list("Financial strengths", explanation.strengths, CheckCircle2, "text-positive")}
              {list("Financial risks", explanation.risks, ShieldAlert, "text-negative")}
              {list("Needs verification", explanation.missing_information, AlertTriangle, "text-caution")}
            </div>
            <div className="space-y-3 text-sm leading-relaxed">
              <p>
                <span className="font-semibold">Expected cash flow. </span>
                {explanation.cash_flow}
              </p>
              <p>
                <span className="font-semibold">Long-term vs short-term. </span>
                {explanation.strategy_comparison}
              </p>
              <p>
                <span className="font-semibold">Sensitivity. </span>
                {explanation.sensitivity}
              </p>
            </div>
            {list("Due diligence questions", explanation.due_diligence_questions, ListChecks, "text-muted-foreground")}
            <p className="text-xs text-muted-foreground">{data.disclaimer}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ----------------------------------------------------------------------------- comparables

export function ComparablesTable({ comparables, priceLabel, perMonth = false }: { comparables: Comparable[]; priceLabel: string; perMonth?: boolean }) {
  if (!comparables.length) return <p className="px-5 pb-5 text-sm text-muted-foreground">No comparables were returned by the provider.</p>;
  return (
    <Table>
      <thead>
        <tr>
          <Th className="pl-5">Address</Th>
          <Th className="text-right">{priceLabel}</Th>
          <Th className="text-right">Beds / baths</Th>
          <Th className="text-right">Sqft</Th>
          <Th className="text-right">Distance</Th>
          <Th className="text-right">Listed</Th>
          <Th className="pr-5 text-right">Similarity</Th>
        </tr>
      </thead>
      <tbody>
        {comparables.map((comp, i) => (
          <tr key={`${comp.formatted_address}-${i}`}>
            <Td className="max-w-[280px] truncate pl-5">
              {comp.formatted_address}
              <span className="block text-[11px] text-muted-foreground">{titleCase(comp.property_type)}</span>
            </Td>
            <Td className="tnum text-right font-medium">
              {usd(comp.price)}
              {perMonth ? <span className="font-normal text-muted-foreground">/mo</span> : null}
            </Td>
            <Td className="tnum text-right">
              {comp.bedrooms ?? "—"} / {comp.bathrooms ?? "—"}
            </Td>
            <Td className="tnum text-right">{comp.square_feet ? num(comp.square_feet) : "—"}</Td>
            <Td className="tnum text-right">{comp.distance_miles != null ? `${comp.distance_miles.toFixed(2)} mi` : "—"}</Td>
            <Td className="tnum text-right">{comp.days_old != null ? `${comp.days_old} d ago` : shortDate(comp.listed_date)}</Td>
            <Td className="tnum pr-5 text-right">{comp.similarity != null ? pct(comp.similarity * 100, 0) : "—"}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function Freshness({ provider, fetchedAt, demo }: { provider?: string | null; fetchedAt?: string | null; demo?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {demo ? <Badge tone="demo">Demo</Badge> : null}
      Source: {provider ?? "—"} · retrieved {relativeTime(fetchedAt)}
    </span>
  );
}
