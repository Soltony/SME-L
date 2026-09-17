# SME Lending

A lending platform for small-business credit: products and pricing, credit scoring, applications,
disbursement through core banking, accrual, repayment through a wallet gateway, and a
double-entry ledger that reconciles against the loan book.

Two front doors:

- **Borrower** — the pages served inside the super-app web view (`/home`, `/products`, `/loans`,
  `/applications`, `/profile`).
- **Staff** — the console at `/admin`, permission-driven, with maker-checker on everything that
  moves money or changes pricing.

It is a rebuild of an earlier SME lending app. What was wrong with that one and what changed here
is in [docs/REVIEW-OF-SME.md](docs/REVIEW-OF-SME.md).

---

## Running it

Requirements: Node 20 or newer (built on 24), SQL Server 2019 or newer.

```bash
npm install
cp .env.example .env          # then fill it in — see below
npm run db:push               # create the tables
npm run db:seed               # create the first administrator
npm run dev                   # http://localhost:9005
```

`db:seed` prints a one-time password for the administrator account. It must be changed at first
sign-in, and the account cannot use the console until it is.

Optional demo data — twelve loans covering every state, two providers, three products:

```bash
npm run db:seed:demo          # add demo data
npm run db:seed:demo -- --reset   # wipe lending data and rebuild it
```

The minimum `.env` for local work: `DATABASE_URL`, `SESSION_SECRET`, `ALLOWED_ORIGIN`, and
`ALLOW_TEST_LOGIN=true` plus `CBS_SIMULATE=true` so you can sign in as a borrower by phone number
and disburse without a bank. Every variable is documented in [.env.example](.env.example).

### Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server on port 9005 |
| `npm run build` / `npm start` | Production build / serve on port 3006 |
| `npm test` | Unit tests (vitest) |
| `npm run typecheck` | `tsc --noEmit`; the build type-checks too |
| `npm run db:push` / `db:seed` / `db:seed:demo` | Schema, first admin, demo data |
| `npm run run:worker` | Maintenance loop; `-- --once` for a single pass |
| `npm run ledger:verify` | Reconcile the books; exits non-zero if anything is off |
| `npm run db:backfill-phones` | Record each borrower's current number in their phone history (safe to re-run) |

### Daily maintenance

Interest and penalties accrue, stale payments expire, queued disbursements are retried, and
reminders go out — once per business day, driven from outside the request cycle. Either:

```bash
curl -X POST -H "x-cron-secret: $CRON_SECRET" https://your-host/api/cron/tick
```

or run `npm run run:worker` as a service. Both are safe to run repeatedly: each job claims the day
before doing anything, so a double invocation accrues once, and a missed day is caught up on the
next pass rather than skipped.

Due-date reminders wait for the hour set in **Settings → Notifications** (09:00 business time by
default), so run the tick at least hourly for them to go out on time. The wording of every borrower
SMS, a switch per message and the delivery log are under **Notifications** in the console.

### Deploying

Serve it over HTTPS behind a reverse proxy, with `TRUST_PROXY=true` so client addresses and the
origin check read the forwarded headers. `NODE_ENV=production` disables the test sign-in, core
banking simulation and the business-date override no matter what the environment says.

---

## How it is put together

```
src/lib/money.ts              integer santim; BigInt rate maths
src/lib/business-date.ts      business days as integers in one declared timezone
src/lib/lending/terms.ts      the terms snapshot a loan is priced by
src/lib/lending/engine.ts     pure loan mathematics — schedule, accrual, payment waterfall
src/lib/lending/*             services: applications, disbursement, payments, loan state
src/lib/accounting/*          chart of accounts, journals, trial balance, verification
src/lib/approvals.ts          maker-checker registry
src/proxy.ts                  authentication, CSRF and deny-by-default routing
src/worker.ts                 maintenance outside the request cycle
```

**Money.** Amounts are integer santim, never floats. Decimal strings are parsed digit by digit —
`Number('0.285') * 100` is `28.499999999999996`, and that drift ends up in a ledger. Rates are
micro-percent integers and multiplication goes through BigInt with half-up rounding, so the same
inputs give the same santim everywhere.

**Business dates.** A day is an integer count of days in `BUSINESS_UTC_OFFSET_MINUTES`, not
"midnight wherever the server runs". Interest for a day, a due date and days past due mean the
same thing on every host.

**The engine is pure.** `engine.ts` has no database and no clock. The nightly accrual, a repayment,
the admin screen and the borrower's calculator all call the same functions, so the screen cannot
disagree with the ledger. Tax is rounded per charge as it is charged, so a loan accrued nightly and
one caught up after an outage land on identical balances.

**Loans carry their terms.** Every loan stores an immutable snapshot of its pricing. Editing a
product changes what new borrowers get and never reprices a loan already on the books.

**A borrower is not their phone number.** The super app identifies borrowers by phone, but people
change SIM cards, and a loan does not end because a number did. Loans, applications and repayments
hang off the immutable `Borrower.id`, and every number a borrower has used is kept in
`BorrowerPhone`, so a change of number moves nothing: their live loan stays visible and payable, and
their repayment history still counts. A returning borrower on a new number is recognised either
because core banking confirms the new number holds an account already verified for exactly one
borrower, or because staff approved a phone change. The automatic match is deliberately narrow — one
borrower only, bank-confirmed accounts only, audited every time — because an account can have more
than one holder; `lending.linkPhoneByVerifiedAccount` turns it off for operators who would rather
link only through approval. If a second record was created before the link, it is folded into the
first, keeping any restriction from either.

**Money moves in a fixed order.** A payment settles penalties, then service fee, interest, tax and
principal, oldest installment first. Anything left over becomes a credit the borrower can be
refunded — it is never discarded.

**Disbursement is three-valued.** Core banking answers succeeded, failed, or unknown. A loan goes
ACTIVE only on a confirmed success; principal is reserved against the provider's fund until then;
an unknown lands in a queue for a human to resolve through maker-checker. Nothing accrues against
a borrower who has not been paid.

**The ledger is double-entry and immutable.** One book per provider. Journals must balance to post,
are idempotent on a key, and are corrected by reversing entries, never by editing. `verifyLedger`
proves debits equal credits, every account balance equals the sum of its lines, and each control
account equals the loan sub-ledger it summarises.

**Concurrency.** Balances are guarded by database application locks taken in a fixed order
(borrower → provider funds → loan), status changes are atomic claims, and document numbers come
from SQL Server sequences. Two callbacks for one payment, or two applications against one limit,
resolve to exactly one.

**Maker-checker.** Pricing, settings, capital, manual repayments, reversals, write-offs, refunds and
disbursement resolutions exist only as requests until a second person approves them. There is no
direct-write path around it, the maker can never approve their own request, and the payload is
re-validated at the moment it is applied.

---

## Security

Ported from the Guess Low Win Big codebase and tightened here:

- Secrets fail closed: missing, short or placeholder values throw rather than signing anything.
- JWT access tokens with rotating refresh tokens backed by database sessions, with idle and
  absolute limits; changing a password revokes every session.
- CSRF origin check on every mutating request (including the forwarded host), deny-by-default
  routing — an unmapped API is refused, not allowed — and role constraints applied to APIs, not
  only to menus.
- CSP with a per-request nonce, no external image or script hosts, HSTS, frames denied by default.
- Rate limits per action and per identity, request bodies capped and rejected if they contain
  markup, and internal errors never returned to the caller.
- Passwords are policy-checked and bcrypt-hashed; one-time passwords are sent by SMS and never
  written to the delivery log; audit entries are written in the same transaction as the change
  they describe, with sensitive fields redacted.
- Uploads are identified by magic number, stored outside the web root under generated names, and
  served only through an authenticated route.

---

## Testing

`npm test` covers the loan engine (schedules, accrual, penalties, waterfall, payoff, reversal),
money arithmetic, journal validation, scoring and tier rules, spreadsheet uploads, the business
calendar, permissions and the security helpers.

For flows that need a database, seed the demo data and use the console — `npm run ledger:verify`
after any exercise proves the books still reconcile.
