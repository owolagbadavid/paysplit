import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const MAIL = 'http://localhost:8026/api/v1';
const EMULATOR = 'http://localhost:4010/control';
const PASSWORD = 'Correct-Horse-9';
const ADMIN_PASSWORD = 'Admin-Horse-99';
const run = Date.now();
const email = `paul-${run}@example.com`;
const adminEmail = `marcus-${run}@example.com`;
const shots = process.env.SHOTS;

async function shot(page: Page, name: string) {
  if (!shots) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
}

async function accessible(page: Page, name: string) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect
    .soft(
      violations.map(
        (v) =>
          `${name}: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.target} ${v.nodes[0]?.failureSummary?.split('\n')[1] ?? ''}`,
      ),
    )
    .toEqual([]);
}

async function newestMail(to: string, subject: RegExp): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`${MAIL}/search?query=${encodeURIComponent(`to:${to}`)}`)).json();
    const found = list.messages.find((m: { Subject: string }) => subject.test(m.Subject));
    if (found) return (await (await fetch(`${MAIL}/message/${found.ID}`)).json()).Text;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No mail matching ${subject} for ${to}`);
}

test.describe.configure({ mode: 'serial' });

let page: Page;
let admin: Page;
test.beforeAll(async ({ browser }) => {
  execFileSync(
    'pnpm',
    ['--filter', '@paysplit/api', 'admin:create:emulated', adminEmail, 'Marcus', 'Vance'],
    {
      cwd: '..',
      env: { ...process.env, ADMIN_PASSWORD },
      stdio: 'pipe',
    },
  );
  page = await (await browser.newContext()).newPage();
  admin = await (await browser.newContext()).newPage();
});

test('someone signs up, verifies their email and lands on the welcome screen', async () => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('salary partitions');
  await shot(page, '01-landing');
  await accessible(page, 'landing');
  await page.getByRole('link', { name: 'Get Started' }).click();
  await page.getByLabel('First Name').fill('Paul');
  await page.getByLabel('Last Name').fill('Clarke');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('short');
  await page.getByLabel('Confirm password').fill('other');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Passwords do not match')).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await shot(page, '02-register');
  await accessible(page, 'register');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('heading', { name: 'Please check your email' })).toBeVisible();
  const code = /^(\d{6})$/m.exec(await newestMail(email, /Verify your/))![1]!;
  await page.getByLabel('Digit 1').fill(code[0]!);
  for (let i = 1; i < 6; i++) await page.getByLabel(`Digit ${i + 1}`).fill(code[i]!);
  await shot(page, '03-verify');
  await page.getByRole('button', { name: 'Verify email' }).click();
  await expect(page.getByText('Welcome to PaySplit, Paul').last()).toBeVisible();
  await shot(page, '04-welcome');
  await accessible(page, 'welcome');
});

test('the dashboard prompts an unverified person and keeps money actions locked', async () => {
  await page.getByRole('link', { name: 'Go to dashboard' }).click();
  await expect(page.getByText('Complete onboarding', { exact: true })).toBeVisible();
  await shot(page, '05-dashboard-empty');
  await accessible(page, 'empty dashboard');
  await page.getByRole('button', { name: 'Complete Onboarding' }).click();
  await shot(page, '06-setup-drawer');
  await page.getByRole('link', { name: 'Start' }).click();
});

test('they complete KYC with a BVN and a selfie', async () => {
  await page.getByLabel('Mobile Phone Number').fill('803 456 7890');
  await shot(page, '07-kyc-profile');
  await accessible(page, 'kyc profile');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('BVN number').fill('11111111111');
  await page.getByRole('button', { name: 'Verify BVN' }).click();
  await expect(page.getByText('We could not find that number').first()).toBeVisible();
  await page.getByLabel('BVN number').fill('22222222222');
  await shot(page, '08-kyc-identity');
  await accessible(page, 'kyc identity');
  await page.getByRole('button', { name: 'Verify BVN' }).click();
  await page.getByRole('button', { name: 'Open camera' }).click();
  await expect(page.getByText('Position your face')).toBeVisible();
  await page.waitForTimeout(1200);
  await shot(page, '09-kyc-liveness');
  await accessible(page, 'kyc liveness');
  await page.getByRole('button', { name: 'Take shot' }).click();
  await expect(page.getByText('Identity Approved').last()).toBeVisible();
  await shot(page, '10-kyc-approved');
});

test('the setup wizard creates income, wallet, beneficiary and an active rule', async () => {
  await page.getByRole('link', { name: 'Continue to Setup Checklist' }).click();
  await page.getByLabel('Employer').fill('Talent Nation');
  await page.getByLabel('Monthly Salary Amount').fill('600,000');
  await shot(page, '11-wizard-income');
  await accessible(page, 'wizard income');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Wallet Name').fill('Dec Trip Fund');
  await page.getByLabel('Select Category').selectOption('travel');
  await page.getByLabel('Budget Target Amount').fill('1,000,000');
  await shot(page, '12-wizard-wallet');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Bank Name').selectOption({ label: 'Guaranty Trust Bank' });
  await page.getByLabel('Account Number').fill('0123456701');
  await expect(page.getByLabel('Beneficiary Name')).not.toHaveValue('');
  await page.getByLabel('Beneficiary Name').fill('Mother');
  await shot(page, '13-wizard-beneficiary');
  await page.getByRole('button', { name: 'Create Split Rule' }).click();
  await page.getByLabel('Rule Name').fill('Save for the trip');
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('200,000');
  await shot(page, '14-wizard-rule');
  await page.getByRole('button', { name: 'Review rule' }).click();
  await page.getByRole('button', { name: 'Complete Setup & Launch Dashboard' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('View Account Details')).toBeVisible();
  await expect(page.getByText('Complete onboarding', { exact: true })).toHaveCount(0);
});

test('they add a beneficiary rule and a failing one', async () => {
  await page.goto('/rules');
  await page.getByRole('button', { name: 'Add New Rule' }).click();
  await page.getByLabel('Rule Name').fill('Mum monthly');
  await page.getByLabel('Priority').selectOption('2');
  await page.getByText('Send to Beneficiary').click();
  await page.getByLabel('Select Beneficiary').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Percentage (%)' }).click();
  await page.getByLabel('Percentage of salary').fill('10');
  await shot(page, '15-rule-form');
  await accessible(page, 'rule form');
  await page.getByRole('button', { name: 'Review rule' }).click();
  await shot(page, '16-rule-review');
  await page.getByRole('button', { name: 'Activate Split Rule' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'Mum monthly', exact: true })).toBeVisible();

  await page.goto('/destinations?tab=beneficiary');
  await page.getByRole('button', { name: 'Add beneficiary' }).click();
  await page.getByLabel('Bank Name').selectOption({ label: 'Zenith Bank' });
  await page.getByLabel('Account Number').fill('0123456700');
  await expect(page.getByLabel('Beneficiary Name')).not.toHaveValue('');
  await page.getByLabel('Beneficiary Name').fill('Landlord');
  await page.getByRole('button', { name: 'Create Rule' }).click();
  await page.getByLabel('Rule Name').fill('Rent');
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('50,000');
  await page.getByLabel('Priority').selectOption('3');
  await page.getByRole('button', { name: 'Review rule' }).click();
  await page.getByRole('button', { name: 'Activate Split Rule' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'Landlord', exact: true })).toBeVisible();
  await shot(page, '17-beneficiaries');
  await accessible(page, 'beneficiaries');

  await page.goto('/destinations');
  await page.getByRole('button', { name: 'Create Wallet' }).click();
  await page.getByLabel('Wallet Name').fill('Emergency Buffer');
  await page.getByLabel('Select Category').selectOption('emergency');
  await page.getByLabel('Accent Color').selectOption('orange');
  await page.getByLabel('No target amount').check();
  await shot(page, '18-wallet-form');
  await accessible(page, 'wallet form');
  await page.getByRole('button', { name: 'Create Rule' }).click();
  await page.getByLabel('Rule Name').fill('Emergency fund');
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('500,000');
  await page.getByLabel('Priority').selectOption('4');
  await page.getByRole('button', { name: 'Review rule' }).click();
  await page.getByRole('button', { name: 'Activate Split Rule' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Emergency Buffer' })).toBeVisible();
  await page.goto('/rules');
  await expect(page.getByText('Some rules would be skipped at this salary')).toBeVisible();
  await shot(page, '19-rules');
  await accessible(page, 'rules');
});

test('an administrator sends a test salary and watches the split settle', async () => {
  await admin.goto('/admin');
  await expect(admin.getByRole('heading', { name: 'Welcome back!' })).toBeVisible();
  await shot(admin, '30-admin-login');
  await accessible(admin, 'admin login');
  await admin.getByLabel('Email').fill(adminEmail);
  await admin.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD);
  await admin.getByRole('button', { name: 'Confirm' }).click();
  await expect(admin.getByRole('heading', { level: 1 })).toContainText('Marcus');
  await admin.getByRole('link', { name: 'Manage Users' }).first().click();
  await admin.getByLabel('Search name or email').fill(email);
  await expect(admin.getByRole('row')).toHaveCount(2);
  await shot(admin, '31-admin-users');
  await accessible(admin, 'admin users');
  await admin.getByRole('button', { name: 'Pay salary' }).click();
  await admin.getByLabel('Salary amount').fill('600,000');
  await shot(admin, '32-admin-pay');
  await accessible(admin, 'admin pay salary');
  await admin.getByRole('button', { name: 'Send test salary' }).click();
  await expect(admin.getByRole('heading', { name: 'Test salary run' })).toBeVisible();
  await expect(admin.getByText('Confirmed', { exact: true }).first()).toBeVisible();
  await expect(admin.getByRole('cell', { name: 'Save for the trip', exact: true })).toBeVisible();
  await expect(admin.getByText('Retrying').first()).toBeVisible();
  await shot(admin, '33-admin-run');
  await accessible(admin, 'admin run');
});

test('the owner sees the split, the skipped rule and the retrying transfer', async () => {
  await page.goto('/dashboard');
  await expect(page.getByText('₦290,000').first()).toBeVisible();
  await shot(page, '20-dashboard');
  await accessible(page, 'dashboard');
  await page
    .getByRole('link', { name: /allocated/ })
    .first()
    .click();
  await expect(page.getByText('Skipped: insufficient funds').first()).toBeVisible();
  await shot(page, '21-split');
  await accessible(page, 'split');
  await page.goto('/transactions');
  await expect(page.getByText('Transfer to Mother').first()).toBeVisible();
  await shot(page, '22-transactions');
  await accessible(page, 'transactions');
  await page
    .getByRole('row', { name: /Transfer to Mother/ })
    .getByRole('button')
    .click();
  await expect(page.getByRole('heading', { name: 'Transaction Details' })).toBeVisible();
  await shot(page, '23-transaction');
  await accessible(page, 'transaction drawer');
  const [receipt] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Receipt' }).click(),
  ]);
  expect(receipt.suggestedFilename()).toMatch(/^paysplit-receipt-PAY-.*\.pdf$/);
  if (shots) await receipt.saveAs(`${shots}/receipt.pdf`);
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Export Statement' }).click();
  const [csv] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download CSV' }).click(),
  ]);
  expect(csv.suggestedFilename()).toMatch(/\.csv$/);
  expect(await newestMail(email, /Receipt: ₦60,000.00 to Mother/)).toContain('60,000.00');
});

test('they move money back from a wallet', async () => {
  await page.goto('/destinations');
  await shot(page, '24-destinations');
  await accessible(page, 'destinations');
  await page.getByRole('link', { name: 'View Dec Trip Fund' }).click();
  await shot(page, '25-wallet');
  await accessible(page, 'wallet');
  await page.getByRole('button', { name: 'Move to Salary Account' }).click();
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('900,000');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('You have ₦200,000 available')).toBeVisible();
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('50,000');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Confirm move' }).click();
  await expect(page.getByText('₦150,000').first()).toBeVisible();
});

test('run now funds only what is left, after they change the rule that did not fit', async () => {
  await page.goto('/rules');
  await page.getByRole('button', { name: 'Edit Emergency fund' }).click();
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('100,000');
  await page.getByRole('button', { name: 'Review rule' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Run Now' }).click();
  await expect(page.getByRole('button', { name: 'Confirm and run' })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Mum monthly')).toHaveCount(0);
  await shot(page, '26-run-now');
  await accessible(page, 'run now');
  await page.getByRole('button', { name: 'Confirm and run' }).click();
  await expect(page.getByText('You ran this with Run Now')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Emergency fund', exact: true })).toBeVisible();
  await page.goto('/rules?tab=history');
  await expect(page.getByRole('cell', { name: 'Run Now', exact: true })).toBeVisible();
  await shot(page, '27-history');
  await accessible(page, 'split history');
});

test('a real bank transfer into the account in the same cycle is held, not split again', async () => {
  const { account } = await (await page.request.get('/v1/salary-account')).json();
  await fetch(`${EMULATOR}/bank-transfer`, {
    method: 'POST',
    body: JSON.stringify({ account_number: account.accountNumber, amount: 4_000_000 }),
  });
  await page.goto('/notifications');
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('Another payment arrived this cycle').first()).toBeVisible({ timeout: 1500 });
  }).toPass();
  await shot(page, '28-notifications');
  await accessible(page, 'notifications');
});

test('settings, devices and the administrator’s views all load cleanly', async () => {
  await page.goto('/settings');
  await expect(page.getByText('this device')).toBeVisible();
  await shot(page, '29-settings');
  await accessible(page, 'settings');
  for (const [path, name] of [
    ['/admin', '34-admin-overview'],
    ['/admin/salary', '35-admin-salary'],
    ['/admin/pay-ins', '36-admin-runs'],
    ['/admin/operations', '37-admin-operations'],
    ['/admin/settings', '38-admin-settings'],
  ] as const) {
    await admin.goto(path);
    await admin.waitForLoadState('networkidle');
    await shot(admin, name);
    await accessible(admin, path);
  }
  await admin.getByRole('link', { name: 'Operations' }).click();
  await admin.getByRole('button', { name: 'Check the books' }).click();
  await expect(admin.getByText('The books balance')).toBeVisible();
  await admin.goto('/admin/users');
  await admin.getByLabel('Search name or email').fill(email);
  await expect(admin.getByRole('row')).toHaveCount(2);
  await admin.getByRole('link', { name: 'Paul Clarke', exact: true }).click();
  for (const tab of ['Split', 'Wallets', 'Beneficiary', 'Profile & Verification']) {
    await admin.getByRole('button', { name: tab, exact: true }).click();
    await admin.waitForTimeout(300);
    await shot(admin, `39-admin-user-${tab.split(' ')[0]!.toLowerCase()}`);
    await accessible(admin, `admin user ${tab}`);
  }
});

test('a customer session opens nothing in administration', async () => {
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: 'Welcome back!' })).toBeVisible();
  expect((await page.request.get('/v1/admin/users')).status()).toBe(401);
});

test('phone-sized screens do not scroll sideways', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of [
    '/dashboard',
    '/transactions',
    '/destinations',
    '/destinations?tab=beneficiary',
    '/rules',
    '/settings',
    '/notifications',
  ]) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect.soft(`${path} ${overflow}`).toBe(`${path} 0`);
    if (overflow > 0 && process.env.DBG)
      console.log(
        await page.evaluate(() =>
          [...document.querySelectorAll('main *, header *')]
            .filter(
              (e) =>
                e.getBoundingClientRect().right > document.documentElement.clientWidth + 1 &&
                !e.closest('.overflow-x-auto'),
            )
            .slice(0, 8)
            .map(
              (e) =>
                `${e.tagName}.${String(e.className).slice(0, 90)} ${Math.round(e.getBoundingClientRect().right)}`,
            ),
        ),
      );
    await shot(page, `40-mobile${path.replace(/\W+/g, '-')}`);
  }
});

test('they sign out', async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Paul' }).click();
  await shot(page, '41-profile-menu');
  await page.getByRole('button', { name: 'Log Out' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL('/');
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Welcome back!' })).toBeVisible();
  await shot(page, '42-login');
});
