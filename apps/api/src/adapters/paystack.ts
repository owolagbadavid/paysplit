import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { safeEqual } from '../lib/crypto.ts';
import { AppError, ProviderError } from '../lib/errors.ts';
import { callProvider } from '../lib/http.ts';
import type {
  Bank,
  CollectionAccount,
  PayIn,
  PaymentEvent,
  PaymentProvider,
  TransferOutcome,
  TransferResult,
} from '../ports/payments.ts';

const PROVIDER = 'paystack';

const envelope = z.object({
  status: z.boolean(),
  message: z.string().default(''),
  code: z.string().optional(),
  data: z.unknown().optional(),
});

const transactionData = z.object({
  reference: z.string(),
  status: z.string(),
  amount: z.int(),
  fees: z.int().nullish(),
  currency: z.string(),
  channel: z.string().nullish(),
  domain: z.string().nullish(),
  paid_at: z.string().nullish(),
  created_at: z.string().nullish(),
  metadata: z.unknown().optional(),
  authorization: z
    .object({
      receiver_bank_account_number: z.string().nullish(),
      sender_name: z.string().nullish(),
      sender_bank: z.string().nullish(),
    })
    .nullish(),
  customer: z.object({ customer_code: z.string().nullish() }).nullish(),
});

const transferData = z.object({
  reference: z.string(),
  status: z.string(),
  amount: z.int(),
  transfer_code: z.string().nullish(),
  gateway_response: z.string().nullish(),
  fee_charged: z.int().nullish(),
});

const TRANSFER_OUTCOMES: Record<string, TransferOutcome> = {
  success: 'success',
  failed: 'failed',
  abandoned: 'failed',
  blocked: 'failed',
  rejected: 'failed',
  reversed: 'reversed',
};

const PAYIN_STATUS: Record<string, PayIn['status']> = {
  success: 'success',
  failed: 'failed',
  abandoned: 'failed',
  reversed: 'reversed',
};

/** Paystack's published test card that succeeds without a challenge. It only works with a test key. */
const TEST_CARD = { number: '4084084084084081', cvv: '408', expiry_month: '12', expiry_year: '30' };

export interface PaystackOptions {
  secretKey: string;
  baseUrl: string;
  dvaBank: string;
  timeoutMs: number;
}

/** Payment port over Paystack in test mode. */
export class PaystackProvider implements PaymentProvider {
  readonly name = PROVIDER;
  readonly #options: PaystackOptions;

  constructor(options: PaystackOptions) {
    this.#options = options;
  }

  async provisionCollectionAccount(input: {
    reference: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string;
  }): Promise<CollectionAccount> {
    const customer = z.object({ customer_code: z.string() }).parse(
      await this.#call('POST', '/customer', {
        email: input.email,
        first_name: input.firstName,
        last_name: input.lastName,
        phone: input.phone,
      }),
    );
    // Creating a second account for a customer is refused, so an earlier attempt that timed out is picked up here.
    const existing = await this.#findAccount(customer.customer_code);
    if (existing) return existing;
    const created = await this.#call('POST', '/dedicated_account', {
      customer: customer.customer_code,
      preferred_bank: this.#options.dvaBank,
    });
    return this.#toAccount(customer.customer_code, created);
  }

  async #findAccount(customerCode: string): Promise<CollectionAccount | null> {
    const customer = z
      .object({ dedicated_account: z.unknown().nullish() })
      .parse(await this.#call('GET', `/customer/${encodeURIComponent(customerCode)}`));
    return customer.dedicated_account ? this.#toAccount(customerCode, customer.dedicated_account) : null;
  }

  #toAccount(customerCode: string, raw: unknown): CollectionAccount {
    const account = z
      .object({
        id: z.union([z.int(), z.string()]),
        account_number: z.string(),
        account_name: z.string(),
        bank: z.object({ name: z.string() }),
      })
      .parse(raw);
    return {
      customerCode,
      accountId: String(account.id),
      accountNumber: account.account_number,
      accountName: account.account_name,
      bankName: account.bank.name,
    };
  }

  async listBanks(): Promise<Bank[]> {
    const data = await this.#call('GET', '/bank?currency=NGN&perPage=100&use_cursor=false');
    const banks = z
      .array(z.object({ code: z.string(), name: z.string(), active: z.boolean().nullish() }))
      .parse(data);
    const unique = new Map(
      banks.filter((b) => b.active !== false).map((b) => [b.code, { code: b.code, name: b.name }]),
    );
    return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async resolveAccount(bankCode: string, accountNumber: string) {
    const query = new URLSearchParams({ account_number: accountNumber, bank_code: bankCode });
    const data = z
      .object({ account_name: z.string() })
      .parse(await this.#call('GET', `/bank/resolve?${query}`));
    return { accountName: data.account_name };
  }

  async createRecipient(input: { name: string; bankCode: string; accountNumber: string }) {
    const data = z.object({ recipient_code: z.string() }).parse(
      await this.#call('POST', '/transferrecipient', {
        type: 'nuban',
        name: input.name,
        account_number: input.accountNumber,
        bank_code: input.bankCode,
        currency: 'NGN',
      }),
    );
    return { recipientCode: data.recipient_code };
  }

  async initiateTransfer(input: {
    reference: string;
    amount: bigint;
    recipientCode: string;
    narration: string;
  }): Promise<TransferResult> {
    const data = await this.#call('POST', '/transfer', {
      source: 'balance',
      amount: Number(input.amount),
      recipient: input.recipientCode,
      reference: input.reference,
      reason: input.narration,
      currency: 'NGN',
    });
    return toTransfer(data);
  }

  async getTransfer(reference: string): Promise<TransferResult> {
    return toTransfer(await this.#call('GET', `/transfer/verify/${encodeURIComponent(reference)}`));
  }

  async getPayIn(reference: string): Promise<PayIn> {
    return toPayIn(await this.#call('GET', `/transaction/verify/${encodeURIComponent(reference)}`));
  }

  async listPayIns(input: { from: Date; to: Date }): Promise<PayIn[]> {
    const found: PayIn[] = [];
    for (let page = 1; page <= 20; page++) {
      const query = new URLSearchParams({
        status: 'success',
        from: input.from.toISOString(),
        to: input.to.toISOString(),
        perPage: '100',
        page: String(page),
      });
      const rows = z.array(z.unknown()).parse(await this.#call('GET', `/transaction?${query}`));
      found.push(...rows.map(toPayIn));
      if (rows.length < 100) break;
    }
    return found;
  }

  async submitTestPayIn(input: {
    reference: string;
    amount: bigint;
    email: string;
    metadata: Record<string, string>;
  }): Promise<PayIn> {
    if (!this.#options.secretKey.startsWith('sk_test_'))
      throw new AppError(403, 'test_mode_only', 'Test pay-ins need a test key');
    const data = await this.#call('POST', '/charge', {
      email: input.email,
      amount: Number(input.amount),
      reference: input.reference,
      metadata: input.metadata,
      card: TEST_CARD,
    });
    return toPayIn({ currency: 'NGN', amount: Number(input.amount), ...(data as object) });
  }

  async getBalance(currency: string): Promise<bigint> {
    const rows = z
      .array(z.object({ currency: z.string(), balance: z.int() }))
      .parse(await this.#call('GET', '/balance'));
    return BigInt(rows.find((r) => r.currency === currency)?.balance ?? 0);
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): PaymentEvent {
    const signature = headers['x-paystack-signature'];
    const expected = createHmac('sha512', this.#options.secretKey).update(rawBody).digest('hex');
    if (typeof signature !== 'string' || !safeEqual(signature, expected)) {
      throw new AppError(401, 'invalid_signature', 'Webhook signature does not match');
    }
    const body = z
      .object({ event: z.string(), data: z.object({ reference: z.string().nullish() }).loose() })
      .parse(JSON.parse(rawBody.toString('utf8')));
    const reference = body.data.reference ?? undefined;
    if (reference && body.event.startsWith('charge.')) return { kind: 'payin', type: body.event, reference };
    if (reference && body.event.startsWith('transfer.'))
      return { kind: 'transfer', type: body.event, reference };
    return { kind: 'ignored', type: body.event, reference };
  }

  async #call(method: string, path: string, body?: unknown): Promise<unknown> {
    const { status, body: raw } = await callProvider(PROVIDER, this.#options.baseUrl + path, {
      method,
      headers: { authorization: `Bearer ${this.#options.secretKey}` },
      body,
      timeoutMs: this.#options.timeoutMs,
    });
    const parsed = envelope.safeParse(raw);
    if (!parsed.success)
      throw new ProviderError(PROVIDER, 'unknown', 'Paystack sent an unexpected answer', status);
    if (status >= 400 || !parsed.data.status) {
      const { message, code } = parsed.data;
      const missing = status === 404 || /not found/i.test(message);
      throw new ProviderError(
        PROVIDER,
        missing ? 'not_found' : 'rejected',
        message || 'Paystack refused the request',
        status,
        code,
      );
    }
    return parsed.data.data;
  }
}

function toTransfer(raw: unknown): TransferResult {
  const data = transferData.parse(raw);
  return {
    reference: data.reference,
    outcome: TRANSFER_OUTCOMES[data.status] ?? 'pending',
    providerCode: data.transfer_code ?? undefined,
    reason: data.gateway_response ?? undefined,
    blockedReason:
      data.status === 'otp'
        ? 'Paystack is waiting for an OTP. Turn off transfer confirmation in the dashboard.'
        : undefined,
    amount: BigInt(data.amount),
    fee: BigInt(data.fee_charged ?? 0),
  };
}

function toPayIn(raw: unknown): PayIn {
  const data = transactionData.parse(raw);
  const metadata = (typeof data.metadata === 'object' && data.metadata ? data.metadata : {}) as Record<
    string,
    unknown
  >;
  const fromMetadata =
    typeof metadata.receiver_account_number === 'string' ? metadata.receiver_account_number : undefined;
  return {
    reference: data.reference,
    status: PAYIN_STATUS[data.status] ?? 'pending',
    amount: BigInt(data.amount),
    fee: BigInt(data.fees ?? 0),
    currency: data.currency,
    channel: data.channel ?? 'unknown',
    paidAt: new Date(data.paid_at ?? data.created_at ?? Date.now()),
    receiverAccountNumber: data.authorization?.receiver_bank_account_number ?? fromMetadata,
    customerCode: data.customer?.customer_code ?? undefined,
    senderName: data.authorization?.sender_name ?? undefined,
    senderBank: data.authorization?.sender_bank ?? undefined,
    isTest: data.domain !== 'live',
  };
}
