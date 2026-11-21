// Year-one long-term rental model, mirroring backend/app/finance/engine.py and mortgage.py.
//
// The server stays the source of truth. This copy only exists so the deal simulator can
// show results instantly while a slider is being dragged; the server's numbers replace
// these as soon as the recalculation returns (usually within a second).
import type { AssumptionOverrides, Assumptions } from "./types";

export interface QuickLtr {
  monthly_cash_flow: number;
  annual_cash_flow: number;
  cash_on_cash_pct: number | null;
  cap_rate_pct: number;
  gross_yield_pct: number;
  net_yield_pct: number;
  dscr: number | null;
  noi_annual: number;
  annual_debt_service: number;
  total_cash_invested: number;
  down_payment: number;
  loan_amount: number;
  /** Principal + interest + PMI in the first month. */
  monthly_payment: number;
}

const n = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === "number" ? value : value == null ? NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const cents = (value: number) => Math.round(value * 100) / 100;
const frac = (percent: number) => percent / 100;

/** Apply property-level overrides on top of resolved assumptions, the way the API does. */
export function applyOverrides(base: Assumptions, overrides: AssumptionOverrides | null | undefined): Assumptions {
  const next = { ...base } as Record<string, unknown>;
  for (const [section, fields] of Object.entries(overrides ?? {})) {
    if (!fields || typeof fields !== "object") continue;
    next[section] = { ...((base as Record<string, unknown>)[section] as object), ...(fields as object) };
  }
  return next as Assumptions;
}

function monthlyPayment(principal: number, ratePct: number, months: number): number {
  if (principal <= 0 || months <= 0) return 0;
  const r = frac(ratePct) / 12;
  if (r === 0) return cents(principal / months);
  const growth = (1 + r) ** months;
  return cents((principal * r * growth) / (growth - 1));
}

export function quickLtr(a: Assumptions): QuickLtr | null {
  const acq = a.acquisition;
  const fin = a.financing;
  const fixed = a.fixed;
  const lt = a.long_term;
  const price = n(acq.purchase_price);
  const rent = n(lt.monthly_rent);
  if (price <= 0 || rent <= 0) return null;

  // Loan and first-year debt service (amortised month by month, like a servicer).
  const downPct = n(fin.down_payment_pct);
  const down = cents(price * frac(downPct));
  const loan = cents(price - down);
  const term = Math.max(1, Math.round(n(fin.loan_term_years, 30))) * 12;
  const rate = n(fin.interest_rate_pct);
  const payment = monthlyPayment(loan, rate, term);
  const pmiApplies = loan > 0 && downPct < n(fin.pmi_required_below_down_pct, 20) && n(fin.pmi_annual_rate_pct) > 0;
  const monthlyPmi = pmiApplies ? cents((loan * frac(n(fin.pmi_annual_rate_pct))) / 12) : 0;
  const pmiFloor = (price * n(fin.pmi_removal_ltv_pct, 78)) / 100;
  let balance = loan;
  let debtService = 0;
  for (let month = 1; month <= Math.min(12, term) && balance > 0; month += 1) {
    const pmi = pmiApplies && balance > pmiFloor ? monthlyPmi : 0;
    const interest = cents(balance * (frac(rate) / 12));
    let principal = payment - interest;
    if (month === term || principal >= balance) principal = balance;
    balance -= principal;
    debtService += principal + interest + pmi;
  }
  debtService = cents(debtService);

  // Operations.
  const tax = fixed.property_tax_annual != null ? n(fixed.property_tax_annual) : cents(price * frac(n(fixed.property_tax_rate_pct)));
  const insurance = fixed.insurance_annual != null ? n(fixed.insurance_annual) : cents(price * frac(n(fixed.insurance_rate_pct)));
  const hoa = n(fixed.hoa_monthly);
  const otherMonthly = n(fixed.other_monthly);
  const rentAnnual = cents(rent * 12);
  const otherIncome = cents(n(lt.other_income_monthly) * 12);
  const gross = rentAnnual + otherIncome;
  const vacancyLoss = cents(rentAnnual * frac(Math.min(100, Math.max(0, n(lt.vacancy_pct)))));
  const collected = rentAnnual - vacancyLoss;
  const egi = collected + otherIncome;
  const opex =
    tax +
    insurance +
    cents(hoa * 12) +
    cents(otherMonthly * 12) +
    cents(collected * frac(n(lt.management_pct))) +
    cents(rentAnnual * frac(n(lt.maintenance_pct))) +
    cents(rentAnnual * frac(n(lt.capex_pct))) +
    cents(rent * frac(n(lt.leasing_fee_pct_of_monthly_rent)) * frac(n(lt.annual_turnover_pct))) +
    cents(n(lt.owner_utilities_monthly) * 12);
  const noi = egi - opex;

  // Cash needed at purchase.
  const closing = cents(price * frac(n(acq.closing_cost_pct)));
  const reserves =
    acq.initial_reserves != null
      ? n(acq.initial_reserves)
      : cents((payment + monthlyPmi + tax / 12 + insurance / 12 + hoa + otherMonthly) * n(acq.reserve_months));
  const capitalised = closing + n(acq.inspection_cost) + n(acq.renovation_cost) + n(acq.initial_repair_budget) + n(lt.furnishing_cost) + n(acq.other_acquisition_costs);
  const cashInvested = down + capitalised + reserves;
  const basis = price + capitalised;

  const cashFlow = noi - debtService;
  return {
    monthly_cash_flow: cents(cashFlow / 12),
    annual_cash_flow: cents(cashFlow),
    cash_on_cash_pct: cashInvested > 0 ? cents((cashFlow / cashInvested) * 100) : null,
    cap_rate_pct: cents((noi / price) * 100),
    gross_yield_pct: cents((gross / price) * 100),
    net_yield_pct: cents((noi / basis) * 100),
    dscr: debtService > 0 ? Math.round((noi / debtService) * 1000) / 1000 : null,
    noi_annual: cents(noi),
    annual_debt_service: debtService,
    total_cash_invested: cents(cashInvested),
    down_payment: down,
    loan_amount: loan,
    monthly_payment: cents(payment + monthlyPmi),
  };
}
