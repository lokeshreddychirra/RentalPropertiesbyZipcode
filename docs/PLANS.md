# Plans, pricing and billing

Searches need an account and are **by ZIP code only** (city, state, county, radius and map-area
searches are switched off to keep data costs predictable). Plans meter the two things that cost
money with RentCast:

| | Free | Pro | Premium |
|---|---|---|---|
| Price | $0 | $19 / month | $49 / month |
| ZIP code searches | 1 (lifetime) | 15 / month | 50 / month |
| ZIP codes per search | 1 | 1 | 5 |
| Property reports | 3 (lifetime) | 75 / month | 250 / month |

* **ZIP code search** — each *different* ZIP searched in the period. Re-running a ZIP already
  searched, changing filters or sorting never counts.
* **Property report** — a property-level rent/value estimate or tax record that had to be bought
  from RentCast when a property was opened. Properties already unlocked, or already cached, are free.
* Free allowances are for the lifetime of the account; paid allowances reset on the 1st of each
  month (UTC). Administrators are unlimited. Quotas apply in live data mode only.

**Changing plans.** Administrators edit every plan's price, ZIP searches, property reports and ZIPs
per search under **Users & plans** (`/admin/users`); changes apply immediately. The environment
variables `PLAN_*` (see `.env.example`) are only the defaults. Administrators can also move any
user between plans by hand, reset a user's usage, or disable an account.

## Why these prices

A new ZIP search costs about 2 RentCast requests (sale listings + rental listings) and a property
report about 1. Worst case per month (every allowance used):

| Plan | Requests | Cost on RentCast Developer overage ($0.20) | Cost on a ~$0.07/request plan |
|---|---|---|---|
| Free | 1×2 + 3 = 5 (once) | $1.00 | $0.35 |
| Pro | 15×2 + 75 = 105 | $21 | ≈ $7.75 |
| Premium | 50×2 + 250 = 350 | $70 | ≈ $26 |

Typical users use a fraction of their allowance, and searches of the same ZIP by different users
share the cache. Still, staying on RentCast's free Developer plan with paying users loses money on
heavy users — move to a paid RentCast tier (check current prices on rentcast.io) once you have a few
subscribers. Prices and allowances can be tuned at any time in the admin page.

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
