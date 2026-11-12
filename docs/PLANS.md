# Plans, pricing and billing

Searches need an account and are **by ZIP code only** (city, state, county, radius and map-area
searches are switched off to keep data costs predictable). Plans meter the two things that cost
money with RentCast:

| | Free | Pro | Premium |
|---|---|---|---|
| Price | $0 | $19 / month | $49 / month |
| ZIP code searches | 1 (lifetime) | 5 / month | 15 / month |
| Property reports | 3 (lifetime) | 20 / month | 60 / month |

* **ZIP code search** — each *different* ZIP searched in the period. Re-running a ZIP already
  searched, changing filters or sorting never counts.
* **Property report** — everything specific to one address, fetched together in one tap ("Get the
  full property report" on the property page): the exact rent estimate with comparable rentals, the
  value estimate with comparable sales, and the public property-tax record. These come from three
  RentCast endpoints, so a report makes up to three requests side by side. Anything already saved
  (rent and value for 30 days, a known tax amount) is reused and not bought again. Opening a property
  is free: it shows the full analysis with the ZIP's area rent from the search. If every lookup fails,
  the report is given back.
* Every search covers exactly **one ZIP code**, on every plan (administrators included).
* Free allowances are for the lifetime of the account; paid allowances reset on the 1st of each
  month (UTC). Administrators are unlimited. Quotas apply in live data mode only.

**Changing plans.** Administrators edit every plan's price, ZIP searches and property reports
under **Users & plans** (`/admin/users`); changes apply immediately. The environment
variables `PLAN_*` (see `.env.example`) are only the defaults. Administrators can also move any
user between plans by hand, reset a user's usage, or disable an account.

## Why these prices

The numbers below assume RentCast's **Foundation** plan: $74 a month for 1,000 requests, then $0.06
per request (check current prices at <https://www.rentcast.io/api>).

**What each action costs in RentCast requests**

| Action | Requests |
|---|---|
| First search of a ZIP | 2 (one page of homes for sale + one page of rentals) |
| Same ZIP again within the listing cache period (default 1 day) | 0 |
| Same ZIP again later | 1 (homes for sale only; area rents are kept 30 days) |
| Every 500 homes for sale beyond the first 500 | +1 |
| Opening a property | 0 (the analysis uses the ZIP's area rent from the search) |
| Full property report, on request | Up to 3 (exact rent, value and tax record, fetched together); fewer when some are already saved |

All of these are shared: every user searching the same ZIP or opening the same property reuses the
same cached data.

**Worst realistic month per user** (every allowance used, each ZIP re-checked on 4 more days, no
sharing with other users), with Stripe's 2.9% + $0.30 per payment:

| Plan | Requests | RentCast cost at $0.06 | Price after Stripe fees | Left over |
|---|---|---|---|---|
| Free (once, not monthly) | 1×2 + 3×3 = 11 | $0.66 | $0 | −$0.66 per signup |
| Pro $19 | 5×6 + 20×3 = 90 | $5.40 | $18.15 | $12.75 |
| Premium $49 | 15×6 + 60×3 = 270 | $16.20 | $47.28 | $31.08 |

**Break-even.** Fixed costs are the RentCast plan ($74) plus hosting. Five Pro subscribers
(5 × $18.15 = $90.75) cover the RentCast plan; six cover it with about $30 of paid hosting. The 1,000
included requests are enough for about 11 Pro subscribers who use their whole allowance.

**When to move up a RentCast tier.** Growth ($199 for 5,000, then $0.03) is cheaper than Foundation
above about 3,100 requests a month; Scale ($449 for 25,000) is cheaper than Growth above about 13,300.

Prices and allowances can be tuned at any time in the admin page. Set the RentCast budget under
**Admin Portal → API usage** to match your RentCast plan (for Foundation: 1,000 requests, $0.074 per
request), or searches stop at the old default of 50 requests.

## Online payments (Stripe)

Without Stripe the "Upgrade" buttons explain that payment isn't switched on and an administrator
upgrades users by hand. To take card payments:

1. In Stripe, create two recurring Prices (Pro and Premium) and enable the Customer Portal.
2. Set `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_PREMIUM` and, after step 3,
   `STRIPE_WEBHOOK_SECRET` on the service (on Render: the `Realestate` environment group).
3. Add a webhook endpoint `https://<your-site>/api/v1/billing/webhook` for
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`
   and `customer.subscription.deleted`.

Checkout upgrades the user as soon as Stripe confirms payment; cancellations and failed renewals
move them back to Free. The price shown on the pricing page comes from the admin settings — keep it
in line with the Stripe price.

## Accounts and sign-in details

The admin user list shows each account's email, name, plan, sign-up date, last sign-in, number of
sign-ins, ZIP codes searched and usage. Passwords are stored as Argon2id one-way hashes and can never
be shown to anyone.
