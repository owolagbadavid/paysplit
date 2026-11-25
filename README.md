# PaySplit

PaySplit gives each user a dedicated account for their salary. When the salary arrives, the app divides it between their
savings wallets and other people's bank accounts, using rules they set up in advance.

- Live app: _coming with the deployment_
- Demo video: _coming with the deployment_
- [Tool choices](docs/TOOL_CHOICES.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Deployment](docs/DEPLOY.md)
- API reference: `/docs` on the running app, or [openapi.json](apps/api/openapi.json)

All providers run in test mode, so no real money moves.

## Running it locally

You need Node 24, pnpm 11 and Docker.

```sh
pnpm install
pnpm infra:up                                  # Postgres, Supabase Auth (GoTrue), Mailpit
cp apps/api/.env.example apps/api/.env
pnpm db:migrate
ADMIN_PASSWORD='Choose-One-99' pnpm admin:create admin@example.com Ada Admin
pnpm dev                                       # web :5173, API :4000, provider emulators :4010
```

| Where                       | What                      |
| --------------------------- | ------------------------- |
| http://localhost:5173       | The app                   |
| http://localhost:5173/admin | Admin area                |
| http://localhost:8026       | Every email the app sends |
| http://localhost:4000/docs  | API reference             |

To try the whole flow, sign up and take the code from Mailpit. Verify with BVN `22222222222` and a selfie, finish the setup
wizard, then sign in to `/admin` and press Pay salary. With the emulators, account numbers ending in `00` fail, ones ending
in `99` stay pending, and the rest go through.

### Using the real sandboxes

The setup above talks to small local servers that copy the Paystack and Dojah APIs. The app runs the same adapters either
way and only the base URL changes. To use the real sandboxes, edit `apps/api/.env`:

1. Set `PAYMENT_PROVIDER=flutterwave`, `FLUTTERWAVE_SECRET_KEY` and `FLUTTERWAVE_WEBHOOK_HASH`.
2. Set `DOJAH_APP_ID` and `DOJAH_SECRET_KEY`, and delete `DOJAH_BASE_URL`.
3. Run `pnpm sandbox:check`, which tries each provider call and tells you which ones work on your account.

The server won't start in production if it's pointed at an emulator.

## Tests

```sh
pnpm test        # split engine, then the API against real Postgres and GoTrue
pnpm e2e         # the product in a browser, with WCAG 2.2 AA checks
pnpm typecheck
```

Most of the effort went into the ways money can go wrong:

- Eight webhooks arriving at once, and ten triggers at once, still credit and split a salary once.
- A transfer is paid once even if the answer is lost, the request never arrives, the process dies before sending, or twelve
  workers pick it up together.
- Failed transfers are retried under a new reference and then refunded. Reversed ones are refunded too.
- Postgres rejects edited ledger entries, unbalanced journals, negative balances and statuses moving backwards.
- For random salaries and rules, the allocations plus the remainder always equal the salary to the kobo.

## How it works

Amounts are whole kobo stored as `bigint`. Each movement is a double-entry journal that the database won't let anyone edit,
and balances are added up from those entries.

[planSplit](packages/core/src/engine.ts) decides how a salary is divided. The rule preview, the Run Now review and the real
split all call it, so users get the split they were shown.

Double payments are blocked by unique indexes: one credit per provider reference, one automatic split per salary and per
pay cycle, one allocation per destination per salary, and one live attempt per transfer. If a transfer reference was ever
sent, the app looks it up at the provider before sending anything again.

A webhook only tells the app which payment to check. The app then asks the provider directly, so late, repeated or
out-of-order webhooks do no harm.

Payments, KYC, auth and email each sit behind an interface, and the rest of the code doesn't know which vendor is in use.
That made it possible to move from Paystack to Flutterwave late in the project.

## Where the PRD left room

| Question                         | What I did                                                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What confirms a salary?          | The provider's verify endpoint.                                                                                                                            |
| Which credits count as salary?   | Any credit to the dedicated account. Only the first one in a pay cycle splits by itself, so a bonus doesn't pay everyone twice. The rest wait for Run Now. |
| Which pay cycle is a payment in? | The month with the nearest expected date, in the user's timezone. A salary due on the 28th that lands on the 1st belongs to the earlier month.             |
| What does Run Now do?            | It funds the active rules that salary hasn't funded yet. Percentages are still of the original salary.                                                     |
| Moving money out of a wallet     | It goes back to the salary account straight away, for free, and is never split again automatically.                                                        |
| Rounding                         | Percentages round down to a kobo and the remainder stays in the salary account.                                                                            |
| Provider fees                    | PaySplit pays them and books them as an expense, so users see exact amounts.                                                                               |
| Equal priority                   | The older rule runs first.                                                                                                                                 |
| Limits                           | Nothing moves before verification. After that it's ₦5,000,000 per transfer and ₦20,000,000 a day.                                                          |
| Liveness can't be decided        | The case goes to Pending review and an admin approves or rejects it with a note. Nothing unlocks until then.                                               |
| Launch market                    | Nigeria. People elsewhere can register and set up rules, but verification isn't open to them.                                                              |

## Differences from the Figma

Sign-up asks for a password because the PRD needs one. Button labels are dark and links are a deeper blue, since white on
the brand blue has a contrast of 2.6:1 and AA asks for 4.5:1. The admin area has three extra pages (Salary, Test runs and
Operations) to cover FR-31, FR-32 and reconciliation.

I left out card and bank linking, which the PRD excludes. I also left out profile photos, the push and SMS tabs, and the app
store badges, because nothing here would back them.

## Known limits

- Flutterwave's test mode gives every salary account the same number. Payments are matched by reference, so users stay
  separate.
- Flutterwave wants a BVN or NIN for each account. The adapter sends the test BVN and refuses live keys, because the user's
  own number is erased once they're verified.
- Only Nigeria has a KYC adapter. Passport and licence upload shows as not open yet.
- Rate limits and lockouts are kept in memory, which is fine for one server. Several would need a shared store.
- The app connects as the database owner. The triggers protect the ledger, but a restricted role would be better.
- There's no MFA.
- If a provider pays a transfer after reporting it failed, the app raises a critical issue for someone to look at.

## Folders

```
packages/core     split engine, money, pay cycles, shared validation
apps/api          Fastify API: ports, adapters, modules, routes, migrations
apps/web          React app for customers and admins
tools/emulators   local copies of the Paystack and Dojah APIs for tests
e2e               browser tests and accessibility checks
docs              architecture, tool choices, deployment
```
