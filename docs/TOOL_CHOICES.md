# Tool choices

Every tool here is open source or has a free tier.

## Payments: Flutterwave

I started on Paystack because it has dedicated accounts, account lookup and transfers in one API. With real test keys, card
payments, the bank list and recipients all worked. Dedicated accounts and transfers didn't: a new test account gets
"Dedicated NUBAN is not available for your business" and "You cannot initiate third party payouts".

Flutterwave v3 allowed both on its test account, so the app uses it now. Test salaries confirm themselves, and a transfer
can be told to succeed or fail. Transfer references can't be reused and can be looked up later, which is how the app avoids
paying someone twice. The Paystack adapter is still there and `PAYMENT_PROVIDER` switches between them. I also considered
Monnify, but transfers in its sandbox wait for an OTP.

Two things about Flutterwave needed care. It answers a reused reference with "Payout with this ref already exists", which
the app treats as a reason to look the transfer up, since it may already have been paid. Its transaction list also leaves
out direct charges, so the app checks each waiting pay-in by its own reference.

## KYC: Dojah

Dojah does BVN, NIN, liveness and selfie matching through plain API calls, so I could build the capture screen from the
Figma. Smile ID and Prembly lean on their own widgets or take longer to set up.

Its sandbox checks BVN and NIN properly, but it gives the same liveness and selfie answer for any photo: "spoof" and "match".
That tells you nothing about the person, so those cases go to an admin for review. The liveness response also has a
different shape from the docs, and the adapter handles both.

## Auth: Supabase

Supabase handles password hashing, email verification and resets. It's open source, so the same server runs in Docker and the
tests use it directly. Its admin API can create codes without emailing them, which lets one mailer send everything. Clerk and
Auth0 have no local server, and their hosted screens don't match the design.

Testing against the hosted version turned up a problem. If a new user confirms their email through a magic link, Supabase
clears the password they just chose, and they can't sign in again. The app uses signup links, which keep it.

The app has its own sessions on top of Supabase, so users can see and revoke their devices and no token reaches JavaScript.

## Everything else

| Need           | Choice                              | Reason                                                                                                              |
| -------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Database       | Postgres on Supabase                | Unique indexes, triggers and row locks enforce the money rules. Neon would work too, but it's another account.      |
| Job queue      | Postgres                            | A job is saved in the same transaction as the change that needs it.                                                 |
| Email          | Mailgun, Mailpit locally            | I had a verified domain. Port 2525 works on hosts that block the usual mail ports. There's a Brevo adapter as well. |
| Hosting        | Coolify, Docker                     | Open source and runs the API, worker and web app as one container. On Vercel the worker would need a separate home. |
| Language       | TypeScript                          | The browser and server share one split engine and the same validation.                                              |
| API            | Fastify and Zod                     | The schemas validate requests and generate the OpenAPI file. CI fails if the file is out of date.                   |
| Queries        | Drizzle                             | Typed queries that stay close to SQL. The ledger triggers are handwritten SQL.                                      |
| Web            | React, Vite, TanStack Query         | It's a signed-in app, so server rendering wouldn't add much. Query covers loading, errors and refreshes.            |
| Styling        | Tailwind, native dialogs            | The Figma colours live in one place, and the browser handles focus and Escape in modals.                            |
| PDFs           | pdfkit                              | Receipts and statements without running a headless browser.                                                         |
| Tests          | Vitest, fast-check, Playwright, axe | Random inputs for the engine, real Postgres and GoTrue for the API, a real browser for the product.                 |
| Error tracking | Sentry, optional                    | Free tier, switched on with one variable.                                                                           |

## A few decisions

I wrote local servers that speak the Paystack and Dojah APIs so the tests could run offline. They can drop a response on
purpose, which is how I tested lost answers. A production server refuses to start against them.

The PRD says a pay cycle shouldn't split twice, so a unique index enforces it. A second payment in the month waits until the
user runs it.

Balances are calculated from ledger entries each time. At this size it's fast enough, and a snapshot table could be added
later.

## Development tools

VS Code, Docker, pnpm, Prettier and GitHub Actions. I used Claude Code, Anthropic's AI coding assistant, throughout for
design, implementation and testing.
