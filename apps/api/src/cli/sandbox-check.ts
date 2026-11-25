import { loadConfig } from '../config.ts';
import { createContext } from '../create-context.ts';

/**
 * Exercises every provider call PaySplit depends on against the configured sandboxes and says which work. Run it
 * once after adding keys: some Paystack features depend on the account, and this shows it before a user does.
 * It creates test records at the providers and touches no PaySplit data.
 */
const config = loadConfig();
const { ctx, close } = createContext({ ...config, LOG_LEVEL: 'silent' });
const { payments, auth, verification } = ctx;
const stamp = Date.now();
const email = `sandbox-check-${stamp}@example.com`;
let failures = 0;

async function step<T>(
  name: string,
  run: () => Promise<T>,
  describe: (value: T) => string,
  advice: string,
): Promise<T | null> {
  try {
    const value = await run();
    console.log(`  ok    ${name}: ${describe(value)}`);
    return value;
  } catch (error) {
    failures++;
    console.log(`  FAIL  ${name}: ${(error as Error).message}\n        ${advice}`);
    return null;
  }
}

/** Test payments settle on a delay, so this asks until the answer is final or three minutes pass. */
async function settled<T>(read: () => Promise<T>, status: (value: T) => string): Promise<T> {
  for (let tries = 0; ; tries++) {
    const value = await read().catch((error: unknown) => {
      if (tries >= 18) throw error;
      return null;
    });
    if (value && status(value) !== 'pending') return value;
    if (tries >= 18) throw new Error('still pending after three minutes');
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
}

console.log(`Supabase Auth  ${config.SUPABASE_AUTH_URL}`);
const person = await step(
  'create a user',
  () => auth.createUser({ email, password: `Check-${stamp}-Aa` }),
  () => 'created',
  'Check SUPABASE_AUTH_URL and the service role key.',
);
if (person && person !== 'email_taken') {
  const proof = await step(
    'issue a verification',
    async () => {
      const issued = await auth.issueVerification(email);
      if (issued.code.length !== 6) throw new Error(`the code has ${issued.code.length} digits, not 6`);
      return issued;
    },
    () => '6-digit code',
    'Set Email OTP length to 6 in Authentication, Sign In / Providers, Email.',
  );
  if (proof)
    await step(
      'redeem it',
      async () => {
        const redeemed = await auth.redeem({ token: proof.token }, 'email');
        if (!redeemed) throw new Error('the token was refused');
        return redeemed;
      },
      () => 'accepted',
      'The auth server refused its own token.',
    );
  await step(
    'remove the user',
    () => auth.deleteUser(person.authId),
    () => 'removed',
    'Remove it by hand.',
  );
}

console.log(`Dojah  ${config.DOJAH_BASE_URL}`);
const kyc = verification.forCountry('NG')!;
await step(
  'look up the test BVN',
  () => kyc.lookupIdentity({ type: 'bvn', number: '22222222222' }),
  (r) => (r.found ? `${r.firstName} ${r.lastName}` : 'not found'),
  'Check DOJAH_APP_ID and DOJAH_SECRET_KEY.',
);
await step(
  'look up the test NIN',
  () => kyc.lookupIdentity({ type: 'nin', number: '70123456789' }),
  (r) => (r.found ? `${r.firstName} ${r.lastName}` : 'not found'),
  'Check the app has NIN lookup enabled.',
);
const photo = process.env.SELFIE_BASE64;
if (photo) {
  await step(
    'liveness',
    () => kyc.checkLiveness(photo),
    (r) => `live ${r.live}, score ${r.score}`,
    'Check the app has liveness enabled.',
  );
  await step(
    'face match',
    () => kyc.matchFace({ type: 'bvn', number: '22222222222', imageBase64: photo }),
    (r) => `matched ${r.matched}, score ${r.score}`,
    'Check the app has selfie verification enabled.',
  );
} else {
  console.log('  skip  liveness and face match: set SELFIE_BASE64 to a JPEG in base64');
}

const flutterwave = config.PAYMENT_PROVIDER === 'flutterwave';
console.log(
  `${flutterwave ? 'Flutterwave' : 'Paystack'}  ${flutterwave ? config.FLUTTERWAVE_BASE_URL : config.PAYSTACK_BASE_URL}`,
);
await step(
  'read the balance',
  () => payments.getBalance('NGN'),
  (b) => `${b} kobo`,
  'Check the secret key.',
);
await step(
  'list banks',
  () => payments.listBanks(),
  (b) => `${b.length} banks`,
  'The provider is unreachable.',
);
await step(
  'create a collection account',
  () =>
    payments.provisionCollectionAccount({
      reference: `check-${stamp}`,
      email,
      firstName: 'Sandbox',
      lastName: 'Check',
      phone: '+2348031234567',
    }),
  (a) => `${a.accountNumber} at ${a.bankName}`,
  'Paystack offers dedicated accounts to registered Nigerian businesses. Ask support@paystack.com to enable them.',
);
const payInReference = `psi-check-${stamp}`;
await step(
  'start a test pay-in',
  () =>
    payments.submitTestPayIn({
      reference: payInReference,
      amount: 500_000n,
      email,
      metadata: { purpose: 'sandbox_check' },
    }),
  (p) => p.status,
  'Without this, pay salaries in through https://demobank.paystackintegrations.com instead of the admin screen.',
);
await step(
  'verify that pay-in',
  () =>
    settled(
      () => payments.getPayIn(payInReference),
      (p) => p.status,
    ),
  (p) => `${p.status}, ${p.amount} kobo, fee ${p.fee}`,
  'The charge did not complete.',
);
// Each provider documents one account for test recipients. Its 001 test bank resolves names but cannot be paid.
const account = {
  bankCode: process.env.CHECK_BANK_CODE ?? (flutterwave ? '044' : '057'),
  accountNumber: process.env.CHECK_ACCOUNT ?? (flutterwave ? '0690000031' : '1000000001'),
};
const resolved = await step(
  'resolve an account',
  () => payments.resolveAccount(account.bankCode, account.accountNumber),
  (r) => r.accountName,
  'Test keys get 3 lookups a day at real banks, so this can fail until tomorrow.',
);
const recipient = await step(
  'create a recipient',
  () => payments.createRecipient({ name: resolved?.accountName ?? 'Sandbox Check', ...account }),
  (r) => r.recipientCode,
  'Paystack would not accept that account.',
);
if (recipient) {
  const reference = `psp-check-${stamp}`;
  const sent = await step(
    'send a transfer',
    async () => {
      const result = await payments.initiateTransfer({
        reference,
        amount: 10_000n,
        recipientCode: recipient.recipientCode,
        narration: 'PaySplit check',
      });
      if (result.outcome === 'failed' || result.outcome === 'reversed')
        throw new Error(`the transfer ${result.outcome}: ${result.reason ?? 'no reason given'}`);
      return result;
    },
    (t) => `${t.outcome}${t.blockedReason ? `. ${t.blockedReason}` : ''}`,
    '"Third party payouts" means the Paystack business must be upgraded from Starter. "Balance" means the test balance is empty.',
  );
  if (sent) {
    await step(
      'verify that transfer',
      () =>
        settled(
          () => payments.getTransfer(reference),
          (t) => t.outcome,
        ),
      (t) => t.outcome,
      'Verification is how PaySplit avoids paying twice, so this has to work.',
    );
    await step(
      'refuse a repeated reference',
      () =>
        payments
          .initiateTransfer({
            reference,
            amount: 10_000n,
            recipientCode: recipient.recipientCode,
            narration: 'PaySplit check',
          })
          .then(
            (t) => {
              if (t.outcome !== sent.outcome) throw new Error(`a repeat answered ${t.outcome}`);
              return 'answered with the original transfer';
            },
            (error: Error) => `refused (${error.message})`,
          ),
      (text) => text,
      'A repeated reference must not create a second transfer.',
    );
  }
}
await close();
console.log(
  failures === 0 ? '\nEverything works.' : `\n${failures} check${failures === 1 ? '' : 's'} failed.`,
);
process.exit(failures === 0 ? 0 : 1);
