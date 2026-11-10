# Financial model specification

Everything in this document is implemented in `backend/app/finance/` — a pure, deterministic
library that uses `Decimal` for all money maths and performs no I/O. The same inputs always
produce the same outputs. The LLM never calculates any of these values.

Tests with hand-computed expectations: `backend/tests/test_finance_engine.py`,
`backend/tests/test_scoring_quality.py`.

Percentages are entered as percents (`7.25` = 7.25%) and reported to two decimals; money is
rounded to cents (half-up) at each line item.

## 1. Inputs and where they come from

Every input carries a provenance label that is shown next to it in the UI and returned by the API
(`provenance` map on `POST /analysis/calculate`):

| Label | Meaning | Examples |
|---|---|---|
| `verified` | A fact reported by the listing or a public record | list price, HOA fee, tax from listing/record, verified STR night cap |
| `estimated` | A provider estimate, or a value derived from a rate | rent AVM, ZIP median rent, ADR/occupancy, tax = rate × price |
| `default` | A documented modelling default | vacancy 6%, management 8%, closing costs 3% |
| `user` | Entered by the user (per property, or as a standing default) | any overridden field |
| `unavailable` | No data; the scenario is unavailable or a value is assumed | no rent estimate, HOA not reported (assumed $0) |

Precedence, lowest to highest: model defaults → listing/provider data → the user's standing
defaults → per-property overrides. Property-specific values (price, rent, tax, HOA, ADR,
occupancy) are never taken from standing defaults.

If no reliable rent (or ADR + occupancy) is available, that strategy is reported as
**unavailable** — it is never calculated from an invented number.

### ZIP-level screening rent

Search results are first screened with an area-level rent so that paid property-level
estimates are only requested for promising candidates. Two ZIP statistics are considered and
the **lower** is used:

* the median rent for the home's bedroom count — only if at least 5 rental listings back it;
* living area × the ZIP median rent per square foot — only if the ZIP has at least 20 rental
  listings; when the home's bedroom count has no reliable statistic this figure is capped at
  the highest reliable bedroom median (rent per square foot falls as homes get larger).

Taking the lower value is deliberate: a property with an unverified area-level estimate should
not outrank one with a property-specific estimate just because a thin statistic is high. After
the top-ranked candidates receive property-level estimates the ranking is re-checked, and any
unverified property that has moved into the top N is verified too (up to
`RENT_AVM_MAX_ROUNDS` rounds). ZIP-level estimates are always labelled as such.

### Default assumptions

| Group | Field | Default |
|---|---|---|
| Financing | Down payment / rate / term | 25% / 7.0% / 30 years |
| | PMI | 0.75%/yr of the loan while down payment < 20%, removed when the scheduled balance reaches 78% of the purchase price |
| Acquisition | Closing costs / inspection | 3% of price / $500 |
| | Reserves | 3 months of fixed carrying costs (P&I + PMI + tax + insurance + HOA + other) |
| Ownership | Property tax | Listing or record value; otherwise 1.1% of price (labelled estimated) |
| | Insurance | 0.5% of price (labelled estimated) |
| Long-term | Vacancy / management / maintenance / CapEx | 6% / 8% of collected rent / 8% / 5% of gross rent |
| | Leasing | 50% of one month's rent × 35% annual turnover |
| Short-term | Unavailable nights / average stay | 14 / 3.5 nights |
| | Platform fee / management / maintenance / CapEx | 3% of booking revenue / 20% / 5% / 5% of accommodation revenue |
| | Cleaning | fee charged per stay = cost per turnover = $60 + $25 × bedrooms |
| | Utilities / internet / supplies | $260/mo / $70/mo / $18 per turnover |
| | Furnishing (upfront) | $6,000 + $4,500 × bedrooms |
| Forecast | Rent growth / appreciation / expense inflation / selling costs | 3% / 3% / 2.5% / 6% |

## 2. Mortgage

Monthly payment for principal `P`, monthly rate `r`, `n` payments:

    M = P · r · (1+r)^n / ((1+r)^n − 1)            (P / n when r = 0)

The schedule is built month by month with interest rounded to cents and the final payment
clearing any residue, so yearly principal and interest reconcile exactly to a zero balance.
Annual debt service = principal + interest + PMI for that year. Cash purchases
(`down_payment_pct = 100`) have no loan.

## 3. Long-term rental

    gross annual income      = monthly rent × 12 + other income
    vacancy loss             = rent × vacancy %
    effective gross income   = gross income − vacancy loss
    operating expenses       = property tax + insurance + HOA + other recurring
                               + management (% of collected rent)
                               + maintenance + CapEx (% of gross rent)
                               + leasing + owner-paid utilities
    NOI                      = effective gross income − operating expenses

NOI excludes mortgage payments, depreciation and income taxes.

## 4. Short-term rental

    available nights         = 365 − unavailable nights
    booked nights            = available nights × occupancy          (occupancy basis "available")
                             = 365 × occupancy, capped at available   (occupancy basis "calendar")
                             … then capped at any legal maximum rentable nights
    accommodation revenue    = ADR × booked nights
    stays                    = booked nights / average stay
    cleaning-fee revenue     = fee per stay × stays       (0 when the ADR source already includes cleaning fees)
    gross revenue            = accommodation revenue + cleaning-fee revenue

With no unavailable nights this is exactly `ADR × 365 × occupancy`.

Cleaning is never double-counted: the fee charged to guests is one revenue line and the cleaning
cost is one expense line. When a provider's ADR already bundles cleaning fees (AirDNA does), the
separate fee line is set to zero and only the cost remains.

    operating expenses       = property tax + insurance + HOA + other recurring
                               + platform and booking fees (% of gross revenue)
                               + management + maintenance + CapEx (% of accommodation revenue)
                               + cleaning and supplies (per stay)
                               + utilities + internet + permits + additional STR insurance

Monthly revenue distributes the annual total by days-in-month × a 12-value seasonality profile
(from the provider when available, otherwise flat). Lodging taxes are treated as pass-through
(collected from guests and remitted) and are not modelled as income or expense.

## 5. Return metrics (calculated separately for each strategy)

| Metric | Formula | Kind |
|---|---|---|
| Gross rental yield | annual gross rental income ÷ purchase price | gross |
| Cap rate | NOI ÷ purchase price | operating |
| Net rental yield | NOI ÷ total acquisition basis | operating |
| Monthly cash flow | (NOI − annual debt service) ÷ 12 | leveraged |
| Cash-on-cash return | annual pre-tax cash flow ÷ total cash invested | leveraged |
| DSCR | NOI ÷ annual debt service — **not applicable** for cash purchases | leveraged |

    total cash invested   = down payment + closing + inspection + renovation + initial repairs
                            + furnishing + initial reserves + other acquisition costs
    acquisition basis     = purchase price + the same costs excluding the down payment and reserves

### Break-even occupancy

*Long-term:* the occupancy at which collected rent covers fixed costs, management and debt service:

    occupancy = (fixed costs + debt service − other income) ÷ (annual rent × (1 − management %))

*Short-term:* the share of available nights that must be booked:

    margin per night = ADR × (1 − platform − booking − management − maintenance − CapEx %)
                       + (cleaning fee × (1 − platform − booking %) − cleaning cost − supplies) ÷ average stay
    nights           = (fixed costs + debt service) ÷ margin per night
    occupancy        = nights ÷ available nights

Values above 100% (or above a legal night cap) are reported with an explicit note that the
property cannot break even under the current assumptions.

## 6. Recommendation between strategies

The financially stronger **feasible** strategy is chosen by cash-on-cash return (it accounts for
the extra furnishing capital a short-term rental needs), falling back to annual cash flow.

* A gap under 0.5 percentage points is "comparable" → long-term (operationally simpler).
* STR recorded as **prohibited** → never recommended, and its score is 0.
* STR legality **unknown** or **restricted** → an STR recommendation is always labelled
  conditional on legal verification.

## 7. Data quality and confidence labels

Each strategy gets an additive 0–100 data-quality score.

**Long-term rental**

| Factor | Points |
|---|---|
| Listing freshness | seen ≤ 2 days: 20 · ≤ 7: 15 · ≤ 30: 8 · older or unknown: 0 |
| Rent estimate | property-level AVM with ≥ 5 comps: 40 · 3–4 comps: 30 · < 3 comps: 20 · user-entered: 25 · ZIP-level estimate backed by ≥ 20 listings: 18, otherwise 10 · none: 0 |
| Property tax | source value: 15 · user-entered: 10 · estimated from rate: 5 |
| HOA & insurance | HOA reported: 5 · insurance user-entered: 5, estimated: 2 |
| Listing completeness | beds, baths, sqft, year built, coordinates: 3 each |

**Short-term rental** replaces the rent line with: STR revenue estimate (property-level
provider: 30 · market-level: 20 · user-entered: 18 · none: 0) and STR legality (verified status
recorded: 10 · unknown: 0).

**Labels:** High ≥ 75 · Medium ≥ 55 · Low ≥ 35 · otherwise Insufficient Data.

Hard rules: no income estimate → Insufficient Data; unverified STR legality caps the STR label at
Medium; a listing not confirmed for 30+ days caps the label at Medium.

## 8. Investment score (0–100)

    score = Σ weightᵢ × componentᵢ ÷ Σ weightᵢ

Each component is normalised to 0–100 on a **fixed** scale (linear, clamped), so scores are
comparable across searches rather than relative to the current result set.

| Component | Default weight | 0 points at | 100 points at |
|---|---|---|---|
| Cash-on-cash return | 25% | 0% | 12% |
| Cap rate | 20% | 3% | 10% |
| Monthly cash flow | 20% | −$200 | +$800 |
| DSCR | 10% | 1.00 | 1.75 (cash purchase = 100) |
| Rental estimate confidence | 10% | Insufficient 0 · Low 30 · Medium 65 · High 100 | |
| Vacancy & market risk | 10% | see below | |
| Data freshness / completeness | 5% | the data-quality score | |

Vacancy & market risk = 60% break-even headroom (break-even occupancy ≤ 60% → 100, ≥ 100% → 0)
+ 20% liquidity (days on market ≤ 30 → 100, ≥ 180 → 0, unknown → 50)
+ 20% regulatory (long-term 100; STR permitted 100, unknown 40, restricted 30, prohibited 0).

Weights are user-configurable (Settings) and are always rescaled to total 100%.

**Guard rails** — weak data can never earn a strong ranking:

* confidence Insufficient → score capped at 40
* confidence Low → score capped at 70
* STR prohibited → STR score 0
* strategy unavailable → no score; the property sorts last for that metric

## 9. Forecast (1, 5, 10, 15, 30 years)

For each year `t`:

* income = year-1 income × (1 + rent growth)^(t−1); percentage-based costs follow income
* dollar-denominated costs × (1 + expense inflation)^(t−1)
* vacancy (or STR occupancy shortfall) shifts by the configured points per year
* debt service from the amortization schedule (PMI drops off as scheduled)
* cash flow = NOI − debt service − capital improvements scheduled for that year
* value = purchase price × (1 + appreciation)^t
* equity = value − loan balance
* net sale proceeds = value × (1 − selling costs) − loan balance
* total investor return = cumulative cash flow + net sale proceeds + released reserves − total cash invested

Appreciation, principal reduction and operating cash flow are reported separately.
IRR is solved by bisection on the annual cash-flow series. No value is credited for renovations
or capital improvements. Forecasts are projections under constant user-chosen rates and are
labelled as such wherever they appear.

## 10. Scenarios and sensitivity

| | Conservative | Optimistic |
|---|---|---|
| **Long-term** rent | −8% | +5% |
| vacancy | +4 pts | −2 pts (floor 2%) |
| repairs & maintenance | +25% | −10% |
| management | +2 pts | — |
| **Short-term** ADR | −12% | +7% |
| occupancy | −15% | +8% (cap 95%) |
| low-season demand (when a seasonal profile exists) | 15% weaker | 5% stronger |
| booking / platform fees | +2 pts | — |
| cleaning costs | +15% | −5% |
| Expense inflation (both) | +1 pt | −0.5 pt |

Sensitivity tables vary one input at a time — purchase price (±5/10/20%), interest rate
(±0.5/1/2 pts), rent or ADR (±5/10/20%), occupancy (−15…+10 pts) — and a 5×5 grid shows monthly
cash flow for purchase price × interest rate.

Financing presets: 20% down/30-year, 25% down/30-year, 30% down/15-year (rate −0.6 pt), all
cash, plus the user's current terms and up to five custom scenarios.

## 11. Badges

| Badge | Rule |
|---|---|
| Positive Cash Flow | primary-strategy monthly cash flow > $0 |
| High Rental Yield | long-term gross yield ≥ `HIGH_YIELD_THRESHOLD_PCT` (default 8%) |
| Price Reduced | listing history shows the current price below the previous asking price |
| STR Restrictions | STR legality recorded as restricted or prohibited |
| Below Estimated Market Value | list price ≥ `BELOW_MARKET_THRESHOLD_PCT` (default 5%) under the provider value estimate — only when an estimate exists |
| Needs Data Verification | confidence Low/Insufficient, a conditional STR recommendation, or both rent and tax are area-level estimates |

## Limitations

* Pre-tax model: no depreciation, income tax, or financing points.
* Property tax reassessment after a sale is not predicted; estimated taxes are flagged.
* STR legality is only as good as the registry entries an administrator has recorded.
* All estimates come from third-party data that can be wrong or stale — the confidence label
  and provenance markers exist so that is always visible.
