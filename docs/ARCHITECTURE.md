# Architecture

One Node process runs the API, the web app and the background worker. Postgres holds all the data and the job queue, so a
change and the job it triggers are saved together.

```
Browser ── cookie session ──> Fastify API ──> modules ──> Postgres (schema: paysplit)
                                  ^              │
Payments ── webhook ──────────────┘              ├─ PaymentProvider       ── Flutterwave or Paystack
                                                 ├─ VerificationProvider  ── Dojah (by region)
Worker ── scheduled tasks ──> jobs ──────────────├─ AuthProvider          ── Supabase Auth
                                                 └─ EmailSender           ── SMTP (Mailgun) or Brevo
```

Vendors are only named in `create-context.ts` and the adapters.

## Ledger

| Account                    | Kind      | Holds                                    |
| -------------------------- | --------- | ---------------------------------------- |
| `platform:provider_cash`   | asset     | Money at the provider                    |
| `platform:payout_clearing` | liability | Money held for transfers still in flight |
| `platform:provider_fees`   | expense   | Fees the provider charged                |
| `salary:<user>`            | liability | A user's salary account                  |
| `wallet:<wallet>`          | liability | One wallet                               |

| Event                           | Debit                              | Credit          |
| ------------------------------- | ---------------------------------- | --------------- |
| Salary confirmed                | provider_cash (net), provider_fees | salary (gross)  |
| Wallet allocation               | salary                             | wallet          |
| Transfer committed              | salary                             | payout_clearing |
| Transfer succeeded              | payout_clearing, provider_fees     | provider_cash   |
| Transfer failed                 | payout_clearing                    | salary          |
| Transfer reversed after success | provider_cash                      | salary          |
| Wallet to salary account        | wallet                             | salary          |

Each journal has a unique reference for the event behind it, so the same event can't be posted twice. The triggers in
[0001_ledger_guards.sql](../apps/api/drizzle/0001_ledger_guards.sql) block updates and deletes, check at commit that debits
equal credits, and stop any customer balance going below zero.

## What happens to a salary

1. The provider sends a webhook. The app checks it's genuine, stores it once, queues a job and replies.
2. The job asks the provider about that payment. If it's confirmed, the salary is credited and the split is queued in the
   same transaction.
3. The split locks the user's salary account, checks they're eligible and that the pay cycle hasn't been split, and plans
   the division.
4. One transaction saves the split, every allocation (skipped ones too, with the reason), the wallet movements and a hold
   for each bank transfer.
5. Each transfer gets its own job. The split's status updates as they settle.

If the webhook never arrives, the app checks waiting test pay-ins every minute and the provider's payment list every ten. A
task also looks for salaries that still need splitting every minute, in case a job was lost.

## Transfers

```
queued ─> in_flight ─> success ─> reversed
             │  ↑
             │  └── unknown (looked up, then resumed)
             └─> retrying ─> in_flight … up to 3 attempts ─> failed (money returned)
```

An attempt is saved as submitted before the network call goes out. From then on the app looks it up before sending again. If
the provider still has no record after 30 seconds, it's resent with the same reference, which the provider won't accept
twice. A new reference is only created once the provider says the last one failed.

Timeouts, 5xx responses and unreadable answers count as unknown. If the provider reports a different amount, nothing settles
and a critical issue is raised.

## Scheduled tasks

Each task has a window, such as a minute or a day. To run one, the worker inserts its window into `scheduled_runs`, and only
one insert can succeed. The expected salary date is only used for reminders and display. It never starts a split.

## KYC

A BVN or NIN lookup comes first, then liveness and a selfie match. If the provider's liveness answer can't be relied on, which
is always the case in Dojah's sandbox, the case becomes Pending review. An admin approves or rejects it with a note that goes
in the audit log. The salary account is only created after approval.

## Security

- Supabase Auth keeps passwords. The app never stores or logs them.
- Sessions are random tokens in HttpOnly cookies, and only their hashes are stored. Customers and admins have separate
  cookies, tables and routes.
- CSRF is covered by SameSite cookies, an Origin check and a header other sites can't send.
- Sign-up, reset and sign-in respond the same way for known and unknown emails.
- If an email is verified in a browser that didn't register it, the password has to be set again. Someone who registers
  another person's email gains nothing.
- The BVN or NIN is encrypted between the two KYC steps and then erased. The last four digits and a keyed fingerprint stay.
  Selfies are never stored.
- Beneficiary account numbers are encrypted with AES-256-GCM and masked by default. Revealing one is audited.
- Supabase's REST API exposes the `public` schema. The tables are in `paysplit`, which it doesn't expose.
- Logs have no headers, bodies or query strings.
- Permissions are checked in the services for every restricted action.
- The audit log is append-only and covers rules, money, verification, sign-ins and admin actions.

## Reconciliation

Every hour, and whenever an admin asks, the app checks that:

- total debits equal total credits
- no balance is negative
- every paid transfer has a settlement entry
- the clearing account equals the open transfers
- no salary is allocated beyond its amount

It also compares the provider's balance with the books. A failed check opens an issue, which closes when the check passes.
