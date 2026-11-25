# Deployment

The app is one Docker container. These are the steps for Coolify.

## 1. Supabase

1. Create a project at https://supabase.com.
2. From the database settings, copy the transaction pooler string (port 6543) as `DATABASE_URL` and the session pooler string
   (port 5432) as `DIRECT_DATABASE_URL`.
3. Copy the project URL, add `/auth/v1`, and use it as `SUPABASE_AUTH_URL`. The secret key is `SUPABASE_SERVICE_ROLE_KEY`.
4. In the Authentication settings, set the email OTP length to 6 and the minimum password length to 10. Raise the rate limits
   for sign-ins and token verification, because all calls come from the server's address.

## 2. Flutterwave

Create an account at https://flutterwave.com, stay in test mode and copy the v3 secret key as `FLUTTERWAVE_SECRET_KEY`. Make a
random `FLUTTERWAVE_WEBHOOK_HASH` with `openssl rand -hex 24`.

Some things to know about test mode:

- Every virtual account has the number `0067100155`.
- A test salary confirms in under a minute. Transfers take one to three minutes.
- `0690000031` to `0690000041` at Access Bank (`044`) are test recipients. Transfers to `0690000040` fail on purpose.
- Account lookup returns 503, so the app gets the account name by saving the beneficiary.

For Paystack, set `PAYMENT_PROVIDER=paystack` and `PAYSTACK_SECRET_KEY`. Dedicated accounts and transfers have to be enabled on
the Paystack account first, and "Confirm transfers before sending" has to be off.

## 3. Dojah

Create an app at https://dojah.io with BVN, NIN, selfie and liveness, and copy the sandbox app ID and secret key. The test BVN
is `22222222222` and the test NIN is `70123456789`.

Liveness can't be decided in the sandbox, so each user has to be approved by an admin under Manage Users, In review.

## 4. Mailgun

Verify a domain at https://mailgun.com and create an SMTP user. `EMAIL_FROM` is `PaySplit <that user>`, and `SMTP_URL` looks
like this, with `@` in the user name written as `%40`:

```
smtp://user%40example.com:password@smtp.mailgun.org:2525?requireTLS=true
```

Use `smtp.eu.mailgun.org` for the EU region.

## 5. Check the keys

Put the values in `apps/api/.env`, remove `PAYSTACK_BASE_URL` and `DOJAH_BASE_URL`, and run `pnpm sandbox:check`.

## 6. Coolify

1. Add a new resource from the public repository and choose the Dockerfile build pack.
2. Set the exposed port to 4000 and add the domain.
3. Add the variables below. Turn off the build variable option on each one so no secret ends up in the image.
4. Leave `NODE_ENV` out. The image sets it, and passing it to the build skips packages the build needs.
5. Deploy. Migrations run when the container starts, and the image has its own health check.

| Variable                                             | Value                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| `APP_URL`                                            | The full address with https and no trailing slash           |
| `DATABASE_URL`, `DIRECT_DATABASE_URL`                | From step 1                                                 |
| `DATABASE_SSL`                                       | `true`                                                      |
| `SUPABASE_AUTH_URL`, `SUPABASE_SERVICE_ROLE_KEY`     | From step 1                                                 |
| `DATA_ENCRYPTION_KEY`                                | `openssl rand -base64 32`                                   |
| `FINGERPRINT_KEY`                                    | `openssl rand -hex 32`                                      |
| `CRON_SECRET`                                        | `openssl rand -hex 24`                                      |
| `PAYMENT_PROVIDER`                                   | `flutterwave`                                               |
| `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_WEBHOOK_HASH` | From step 2                                                 |
| `DOJAH_APP_ID`, `DOJAH_SECRET_KEY`                   | From step 3                                                 |
| `EMAIL_FROM`, `SMTP_URL`                             | From step 4                                                 |
| `PROXY_HOPS`                                         | `1`, or `2` if Cloudflare's proxy is in front of the domain |

## 7. After the first deploy

1. In the Flutterwave dashboard, set the webhook URL to `<APP_URL>/webhooks/payments` and the secret hash to
   `FLUTTERWAVE_WEBHOOK_HASH`.
2. Create an admin from your machine, with the same values in `apps/api/.env`:

   ```sh
   ADMIN_PASSWORD='...' pnpm admin:create you@example.com First Last
   ```

3. Sign up, verify, approve the review in `/admin`, add a rule and send a test salary from the user's page.
