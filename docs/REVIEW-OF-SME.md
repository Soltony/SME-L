# What was wrong with the old SME app, and what this one does instead

Written for the team deciding whether to move onto this build.

The original (`Desktop/SME`) got the shape of the product right: providers, products with tiers and
penalty rules, credit scoring off uploaded data, applications, disbursement through core banking,
wallet repayment, approvals. This rebuild keeps that shape. What it does not keep is the arithmetic,
the accounting, the concurrency, and several places where the security control existed but was not
actually connected.

Each item below is a defect found in the original source, the consequence in money or risk terms,
and what this build does. Nothing here is hypothetical; the file references are to the old codebase.

---

## 1. The books could not balance

**Found.** The accrual job posted a debit to interest receivable with no credit at all. A repayment
posted one debit against two credits of the same amount (receivable *and* income). The cash side of
a disbursement was never booked.

**Consequence.** A trial balance that cannot balance by construction. No reliable figure for income,
receivables or cash, and nothing to reconcile against the bank.

**Now.** A real double-entry ledger, one book per provider. A journal that does not balance is
refused before it is written — `validateJournalLines` rejects it, and there is no code path that
posts lines any other way. Journals are immutable and idempotent on a key; corrections are reversing
entries. `npm run ledger:verify` proves three things per provider: debits equal credits, every
account balance equals the sum of its lines, and every control account equals the loan sub-ledger it
summarises. The demo book passes 40 of 40 checks.

## 2. Money was floating point

**Found.** Money was `Float` in the database — `loanAmount`, `serviceFee`, `penaltyAmount`,
`repaidAmount`, `interestAccruedAmount`, every payment amount — and flowed through JavaScript
numbers as currency units, with tax computed as `delta * (taxRate / 100)`.

**Consequence.** `Number('0.285') * 100` is `28.499999999999996`. Fractions of a santim accumulate
into every balance and every ledger total, and no two recomputations agree.

**Now.** Every amount in arithmetic is an integer count of santim. Decimal strings are parsed digit
by digit, never through `Number()`. Rates are micro-percent integers, and multiplying by one goes
through BigInt with explicit half-up rounding, so an intermediate product cannot lose precision.
Money is stored as `Decimal(18,2)` and converted exactly at the boundary.

## 3. Four penalty implementations that disagreed

**Found.** Four separate readers of `penaltyRules`, each with its own arithmetic:
`lib/loan-calculator.ts` (what the screens show), `lib/installment-penalty.ts`,
`lib/penalty-accrual.ts` and `actions/penalty-accrual.ts` (what the ledger is posted from).

**Consequence.** The borrower's screen, the collections report and the ledger each stated a
different debt on the same loan. Disputes could not be settled from the system.

**Now.** One pure engine (`src/lib/lending/engine.ts`) with no database and no clock. The nightly
accrual, a repayment, the admin console and the borrower's payoff quote all call the same functions.
Penalty rules are validated so bands of the same type cannot overlap. Because tax is rounded per
charge as each charge is made, a loan accrued nightly and one caught up after a month-long outage
reach identical balances — the engine tests assert exactly that.

## 4. Editing a product repriced loans already on the books

**Found.** Balances were recomputed from the *current* product row on every read.

**Consequence.** Changing a fee or penalty rule silently rewrote the debt of every existing
borrower, including loans already repaid. Historical statements changed retroactively.

**Now.** Each loan carries an immutable snapshot of its terms, taken when it is created. Product
edits affect new loans only. Pricing changes are themselves maker-checker requests.

## 5. Interest charged on money the borrower never received

**Found.** The loan was booked, journalled and started accruing when the application was saved —
and then the *browser* asked for the money to be sent: `apply/client.tsx` calls
`/api/external/disbursement` after the save returns, with the amount and credit account taken from
the client. A failure was reported as a toast.

**Consequence.** A closed tab, a dropped connection or a refusal from the bank left the borrower
holding a loan that accrued interest and penalties but was never paid out — and nothing in the
system knew the money had not moved.

**Now.** A loan is created as `PENDING_DISBURSEMENT` with its principal reserved against the
provider's fund; nothing is posted and nothing accrues. Core banking's answer is three-valued:
succeeded moves it to `ACTIVE` and posts the disbursement; failed releases the reservation; unknown
goes to a queue where a human resolves it through maker-checker. Timeouts are resolved, not guessed.

## 6. The payment callback — already fixed there, kept and extended here

**Found.** Nothing outstanding. The callback in the current SME code verifies the gateway signature,
requires a pending intent and claims it inside the applying transaction. Its own comment records why:
the only check *used to be* that the Authorization header held a valid super-app token, which every
borrower holds for their own account, so a borrower could start a repayment, never pay, post the
callback themselves and have the loan credited. That was the most serious defect in the app's
history, and it was repaired before this rebuild began.

**Now.** The same checks, carried over deliberately rather than reinvented. A callback must pass, in
order: a valid bearer token, a known pending intent, a signature keyed on the merchant secret, an
amount that matches the intent, and an atomic claim of that intent inside the same transaction that
posts the repayment — so a replayed or concurrent callback applies exactly once. Three additions:
the relaxed signature mode (for confirming a live gateway's format) announces itself on every staff
page for as long as it is on; money arriving for a loan that is already closed is held as a
refundable credit instead of being dropped; and the whole path is covered by tests, including
concurrent replays.

## 7. Overpayments took the borrower's money and recorded nothing

**Found.** A wallet repayment accepted any amount and only detected the overpayment when the
callback arrived — after the wallet had been charged — then marked the payment failed.

**Consequence.** The borrower was charged and nothing was recorded against their loan.

**Now.** The amount is capped at today's payoff before the wallet is charged. Anything that still
arrives in excess becomes a credit balance the borrower can be refunded; refunds are maker-checker
and cannot be applied twice.

## 8. Two requests could spend the same money twice

**Found.** Outside the payment callback, nothing was serialised: no application locks anywhere in the
codebase, and limits were read, decided on, and written in separate steps. Provider funds were two
`Float` columns (`startingCapital`, `initialBalance`) with no reservation and no check at the moment
of disbursement.

**Consequence.** Two applications submitted at once could both pass the same exposure limit, and
nothing at all stopped a provider lending past the money it actually had.

**Now.** Database application locks (`sp_getapplock`) taken in a fixed order — borrower, provider
funds, loan — held by the transaction, so it still serialises across multiple app instances. Status
changes are atomic conditional claims, and document numbers come from SQL Server sequences rather
than a counter row. Verified under concurrent load: two simultaneous applications produce one
disbursed loan and one refusal; simultaneous replays of a callback apply once.

## 9. The audit trail could contradict what happened

**Found.** `createAuditLog` writes through the global Prisma client, and the repayment path calls it
from *inside* the `prisma.$transaction` callback that applies the payment — a separate connection,
outside the transaction it is describing.

**Consequence.** When the transaction rolled back, the audit log still said the money had been
applied.

**Now.** Audit entries are written in the same transaction as the change they describe, so they roll
back with it. Sensitive fields are redacted, and one-time passwords are never written to the
notification log.

## 10. Role restrictions that were never enforced

**Found.** `menu-items.ts` declares `roles` on thirteen entries and `allowedRoles` on none. The
middleware reads `currentRouteConfig.allowedRoles`, finds it undefined every time, and skips the
block that would have refused the request.

**Consequence.** Every role restriction on admin pages was dead code. The check looked present in
review and enforced nothing at runtime.

**Now.** One route registry drives the proxy, the API guard, the sidebar and the role builder, so
they cannot drift apart. Routing is deny-by-default: an API path that is not mapped to a module is
refused rather than allowed. Page-level role constraints apply to the APIs behind those pages too,
and a test asserts every maker-checker kind maps to a module that exists.

## 11. Maker-checker with a way around it

**Found.** Most changes went through approvals, but the direct-write endpoints remained alongside
them: `api/products` POST creates a product outright, and uploads and provider routes write to
products and providers directly, while `api/approvals` applies the same changes after review.

**Consequence.** Anyone with update rights could skip the checker entirely.

**Now.** For everything in the approvals registry there is no direct-write endpoint at all; the only
way to apply one is `decideChange`. The maker can never approve their own request, the checker needs
both the approval right and the module's own approve right, requests are provider-scoped, and the
payload is re-validated when it is applied. Verified: the approver cannot open Users or raise a
posting, the maker cannot approve their own request, and a replayed approval is refused.

## 12. A bank credential hard-coded in the source

**Found.** `src/actions/provider-distribution.ts` fell back to `nibLoan` / `123456` when the
environment variables were missing.

**Consequence.** A working credential in the repository, and a job that silently ran with it.

**Now.** No credential has a literal fallback. Secrets fail closed: missing, short or placeholder
values throw rather than letting the request proceed. The old environment names are still read, so
an existing deployment's `.env` keeps working.

## 13. Uploads trusted the browser

**Found.** Documents were stored as base64 text in the database, the MIME type was whatever the
browser declared, and any application could be attached to.

**Consequence.** Database bloat, and stored files whose type was attacker-controlled.

**Now.** The type is decided by magic number and only PDF, PNG and JPEG are accepted; files live on
disk outside the web root under generated names, with a SHA-256 recorded; downloads go through an
authenticated route that checks who is asking.

## 14. Dates depended on the server's timezone

**Found.** `startOfDay(new Date())`, six times over.

**Consequence.** The same repayment landed on a different day, and accrued a different amount,
depending on the host — and days past due shifted with it.

**Now.** A business day is an integer count of days in one declared timezone
(`BUSINESS_UTC_OFFSET_MINUTES`), date columns are written and read as dates, and a pinned business
date for testing is refused outright in production.

## 15. The eligibility limit rewarded paying interest

**Found.** Outstanding exposure was `loanAmount − repaidAmount`, where `repaidAmount` included
interest, fees and penalties. Loans awaiting disbursement and applications awaiting review were
invisible to the limit.

**Consequence.** Every santim of interest paid raised the borrower's available credit, and a
borrower could hold several applications open against a single limit.

**Now.** Exposure is principal still owed. Pending loans and submitted applications count against the
limit, evaluated inside the same lock and transaction as the application itself. Tier tables with
gaps or overlaps cannot be saved. A borrower with a written-off loan is refused new credit — the
overdue flag alone clears once a loan leaves the active book, which would otherwise let a defaulter
borrow again the day after the write-off.

## 16. Dashboards that got slower as the book grew

**Found.** `lib/loan-calculator.ts` recomputed a loan from scratch on every read — looping day by day
over the overdue period for each installment — and it ran on the loan page, the history pages, the
reports and the USSD endpoints. The ledger, meanwhile, was posted by a different implementation in
`actions/interest-accrual.ts` and `actions/penalty-accrual.ts`.

**Consequence.** Work per page load that grows with portfolio age, and screens computed by different
code from the books they are supposed to reflect.

**Now.** Balances are stored and rolled forward by the nightly accrual; a page projects from the
stored state to today in memory and writes nothing. Same engine as the ledger, so the two agree.

## 17. A worker that could skip a day

**Found.** Each job slept for its own 24 hours.

**Consequence.** A restart at the wrong moment silently skipped a day of accruals.

**Now.** Maintenance is idempotent and claims the business day before acting: running it twice
accrues once, and a missed day is caught up on the next pass. It runs from `/api/cron/tick` (secret
required, constant-time comparison) or `npm run run:worker`.

## 18. The build ignored its own errors

**Found.** `next.config.ts` set `typescript: { ignoreBuildErrors: true }` and
`eslint: { ignoreDuringBuilds: true }`.

**Consequence.** Type errors reached production silently.

**Now.** Both are off. The build type-checks, and it passes with no warnings.

---

## What came from Guess Low Win Big

The security model and the user-management structure were taken from that codebase, which had
already been through a security review, and tightened for a lending context:

- Fail-closed secret loading and CSPRNG helpers.
- JWT access tokens with rotating refresh tokens backed by database sessions, idle and absolute
  limits, and session revocation on password change.
- The proxy: CSRF origin checking, deny-by-default module mapping, role constraints.
- CSP with a per-request nonce, hardened response headers, per-action rate limits, body size and
  content limits, and a handler wrapper that never leaks internals to the caller.
- Password policy, one-time passwords by SMS, lockout after repeated failures, and login responses
  that reveal nothing about which accounts exist.
- The roles-and-permissions model: a permission matrix per module, role presets, the role builder
  and the user manager — extended here with provider scoping, so a provider's staff see only their
  own book.

Three places where this build is stricter than the source it came from:

- **Development bypasses are hard-off in production.** Guess Low allowed its test sign-in anywhere
  and warned with a banner. Here the test sign-in, simulated core banking and the pinned business
  date are ignored when `NODE_ENV=production`, whatever the environment says.
- **The origin check also accepts the forwarded host** (a gap found in the SME review: comparing
  against the request URL alone refuses every production POST behind a reverse proxy).
- **No external image hosts, and every page treated as private** — each one shows personal financial
  data.

---

## Not carried over

Deliberately out of scope for this build, and still available in the old app if they are needed:
salary-advance products and their CSV mappings, SMS campaign management, the USSD borrower
endpoints, the external inbound disbursement API, the real-time hub, and the scheduled
provider-distribution job. The NPL screen, data export and disbursement control are covered here by
the borrowers filter, the CSV exports on reports and accounting, and the disbursement queue with its
kill switch.
