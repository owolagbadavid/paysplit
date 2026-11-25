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

const PROVIDER = 'flutterwave';
const TEST_KEY = 'FLWSECK_TEST-';

/** Flutterwave requires an identity number on a permanent account. Test mode accepts this one for everybody. */
const TEST_BVN = '22222222222';

/**
 * In test mode a transfer stays pending forever unless its reference carries one of Flutterwave's mock endings,
 * which decide how it finishes about a minute later.
 */
const MOCK_SUCCESS = '_PMCKDU_1';
const MOCK_FAILURE = '_PMCKDU_ST_FDU_1';
const MOCK_ENDING = /_PMCK\w*$/;
/** Transfers to this documented test account are asked to fail, so the retry path can be shown. */
const TEST_FAILING_ACCOUNT = '0690000040';

/** Pay-ins started by an administrator, and payments into a salary account, carry these in `tx_ref`. */
const PAY_IN_PREFIX = 'psi-';
const ACCOUNT_PREFIX = 'psa-';

const envelope = z.object({
  status: z.string(),
  message: z.string().nullish(),
  data: z.unknown().optional(),
  meta: z.unknown().optional(),
});

const transactionData = z.object({
  id: z.int(),
  tx_ref: z.string(),
  status: z.string(),
  amount: z.number(),
  app_fee: z.number().nullish(),
  merchant_fee: z.number().nullish(),
  currency: z.string(),
  payment_type: z.string().nullish(),
  created_at: z.string(),
  meta: z
    .object({ originatorname: z.string().nullish(), bankname: z.string().nullish() })
    .nullish()
    .catch(null),
});

const transferData = z.object({
  id: z.int(),
  reference: z.string(),
  status: z.string(),
  amount: z.number(),
  fee: z.number().nullish(),
  complete_message: z.string().nullish(),
  requires_approval: z.number().nullish(),
  is_approved: z.number().nullish(),
});

const beneficiaryData = z.object({
  id: z.int(),
  account_number: z.string(),
  bank_code: z.string(),
  full_name: z.string(),
});

const pageMeta = z.object({ page_info: z.object({ total_pages: z.int() }) });

const TRANSFER_OUTCOMES: Record<string, TransferOutcome> = { SUCCESSFUL: 'success', FAILED: 'failed' };
const PAYIN_STATUS: Record<string, PayIn['status']> = { successful: 'success', failed: 'failed' };

const toKobo = (naira: number) => BigInt(Math.round(naira * 100));
const toNaira = (kobo: bigint) => Number(kobo) / 100;

export interface FlutterwaveOptions {
  secretKey: string;
  webhookHash: string;
  baseUrl: string;
  timeoutMs: number;
}

/**
 * Payment port over Flutterwave v3 in test mode. Every virtual account shares one number there, so payments are
 * matched to people by the account's own reference and never by account number.
 */
export class FlutterwaveProvider implements PaymentProvider {
  readonly name = PROVIDER;
  readonly #options: FlutterwaveOptions;
  readonly #test: boolean;

  constructor(options: FlutterwaveOptions) {
    this.#options = options;
    this.#test = options.secretKey.startsWith(TEST_KEY);
  }

  async provisionCollectionAccount(input: {
    reference: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string;
  }): Promise<CollectionAccount> {
    this.#requireTestKey();
    const txRef = ACCOUNT_PREFIX + input.reference;
    const account = z
      .object({ order_ref: z.string(), account_number: z.string(), bank_name: z.string() })
      .parse(
        await this.#data('POST', '/virtual-account-numbers', {
          email: input.email,
          tx_ref: txRef,
          is_permanent: true,
          bvn: TEST_BVN,
          phonenumber: input.phone,
          firstname: input.firstName,
          lastname: input.lastName,
          narration: `${input.firstName} ${input.lastName}`,
        }),
      );
    return {
      customerCode: txRef,
      accountId: account.order_ref,
      accountNumber: account.account_number,
      accountName: `${input.firstName} ${input.lastName}`,
      bankName: account.bank_name,
    };
  }

  async listBanks(): Promise<Bank[]> {
    const banks = z
      .array(z.object({ code: z.string(), name: z.string() }))
      .parse(await this.#data('GET', '/banks/NG'));
    const unique = new Map(banks.map((b) => [b.code, { code: b.code, name: b.name.trim() }]));
    return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Falls back to the name on a new beneficiary, because Flutterwave's lookup answers 503 to test keys. */
  async resolveAccount(bankCode: string, accountNumber: string) {
    try {
      const data = z.object({ account_name: z.string() }).parse(
        await this.#data('POST', '/accounts/resolve', {
          account_bank: bankCode,
          account_number: accountNumber,
        }),
      );
      return { accountName: data.account_name };
    } catch (error) {
      if (!this.#test || !(error instanceof ProviderError) || error.kind !== 'unknown') throw error;
      const beneficiary = await this.#ensureBeneficiary(bankCode, accountNumber, 'PaySplit');
      return { accountName: beneficiary.full_name };
    }
  }

  async createRecipient(input: { name: string; bankCode: string; accountNumber: string }) {
    const { id } = await this.#ensureBeneficiary(input.bankCode, input.accountNumber, input.name);
    const failing = this.#test && input.accountNumber === TEST_FAILING_ACCOUNT;
    return { recipientCode: failing ? `${id}:fail` : String(id) };
  }

  /** Saves the account with Flutterwave, or finds it when it is already there, since a repeat is refused. */
  async #ensureBeneficiary(bankCode: string, accountNumber: string, name: string) {
    try {
      return beneficiaryData.parse(
        await this.#data('POST', '/beneficiaries', {
          account_bank: bankCode,
          account_number: accountNumber,
          beneficiary_name: name,
          currency: 'NGN',
        }),
      );
    } catch (error) {
      if (!(error instanceof ProviderError) || !/already added/i.test(error.message)) throw error;
    }
    for (let page = 1, pages = 1; page <= Math.min(pages, 50); page++) {
      const { data, meta } = await this.#call('GET', `/beneficiaries?page=${page}`);
      pages = pageMeta.parse(meta).page_info.total_pages;
      const found = z
        .array(beneficiaryData)
        .parse(data)
        .find((b) => b.bank_code === bankCode && b.account_number === accountNumber);
      if (found) return found;
    }
    throw new ProviderError(PROVIDER, 'unknown', 'Flutterwave has this beneficiary but did not list it');
  }

  async initiateTransfer(input: {
    reference: string;
    amount: bigint;
    recipientCode: string;
    narration: string;
  }): Promise<TransferResult> {
    const [beneficiary, mock] = input.recipientCode.split(':');
    const ending = !this.#test ? '' : mock === 'fail' ? MOCK_FAILURE : MOCK_SUCCESS;
    return toTransfer(
      await this.#data('POST', '/transfers', {
        beneficiary: Number(beneficiary),
        amount: toNaira(input.amount),
        currency: 'NGN',
        debit_currency: 'NGN',
        narration: input.narration,
        reference: input.reference + ending,
      }),
    );
  }

  async getTransfer(reference: string): Promise<TransferResult> {
    for (const ending of this.#test ? [MOCK_SUCCESS, MOCK_FAILURE] : ['']) {
      const sent = reference + ending;
      const rows = z
        .array(transferData)
        .parse(await this.#data('GET', `/transfers?reference=${encodeURIComponent(sent)}`));
      const row = rows.find((r) => r.reference === sent);
      if (row) return toTransfer(row);
    }
    throw new ProviderError(PROVIDER, 'not_found', 'Flutterwave has no such transfer');
  }

  async getPayIn(reference: string): Promise<PayIn> {
    const path = reference.startsWith('flw-')
      ? `/transactions/${encodeURIComponent(reference.slice(4))}/verify`
      : `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`;
    return this.#toPayIn(transactionData.parse(await this.#data('GET', path)));
  }

  /** Only PaySplit's own payments: the Flutterwave account may be shared with other software. */
  async listPayIns(input: { from: Date; to: Date }): Promise<PayIn[]> {
    const day = (date: Date) => date.toISOString().slice(0, 10);
    const found: PayIn[] = [];
    for (let page = 1, pages = 1; page <= Math.min(pages, 20); page++) {
      const query = new URLSearchParams({
        status: 'successful',
        from: day(input.from),
        to: day(new Date(input.to.getTime() + 86_400_000)),
        page: String(page),
      });
      const { data, meta } = await this.#call('GET', `/transactions?${query}`);
      pages = pageMeta.parse(meta).page_info.total_pages;
      for (const row of z.array(z.unknown()).parse(data)) {
        const parsed = transactionData.safeParse(row);
        if (parsed.success && isOurs(parsed.data.tx_ref)) found.push(this.#toPayIn(parsed.data));
      }
    }
    return found.filter((p) => p.paidAt >= input.from);
  }

  /** Starts a bank transfer charge, which Flutterwave's test mode pays by itself a few seconds later. */
  async submitTestPayIn(input: {
    reference: string;
    amount: bigint;
    email: string;
    metadata: Record<string, string>;
  }): Promise<PayIn> {
    this.#requireTestKey();
    await this.#data('POST', '/charges?type=bank_transfer', {
      tx_ref: input.reference,
      amount: toNaira(input.amount),
      currency: 'NGN',
      email: input.email,
      narration: 'PaySplit test salary',
      meta: input.metadata,
    });
    return {
      reference: input.reference,
      status: 'pending',
      amount: input.amount,
      fee: 0n,
      currency: 'NGN',
      channel: 'bank_transfer',
      paidAt: new Date(),
      isTest: true,
    };
  }

  async getBalance(currency: string): Promise<bigint> {
    const data = z
      .object({ available_balance: z.number() })
      .parse(await this.#data('GET', `/balances/${encodeURIComponent(currency)}`));
    return toKobo(data.available_balance);
  }

  /** Flutterwave proves itself with a shared secret header, so an event only ever says what to look up. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): PaymentEvent {
    const hash = headers['verif-hash'];
    if (typeof hash !== 'string' || !safeEqual(hash, this.#options.webhookHash))
      throw new AppError(401, 'invalid_signature', 'Webhook signature does not match');
    const body = z
      .object({
        event: z.string().default('unknown'),
        data: z
          .object({ id: z.int().nullish(), tx_ref: z.string().nullish(), reference: z.string().nullish() })
          .loose()
          .optional(),
      })
      .parse(JSON.parse(rawBody.toString('utf8')));
    const { event: type, data } = body;
    if (type.startsWith('charge.') && data?.tx_ref && data.id != null && isOurs(data.tx_ref))
      return { kind: 'payin', type, reference: payInReference(data.tx_ref, data.id) };
    if (type.startsWith('transfer.') && data?.reference)
      return { kind: 'transfer', type, reference: data.reference.replace(MOCK_ENDING, '') };
    return { kind: 'ignored', type, reference: data?.tx_ref ?? data?.reference ?? undefined };
  }

  #toPayIn(data: z.infer<typeof transactionData>): PayIn {
    const intoAccount = data.tx_ref.startsWith(ACCOUNT_PREFIX);
    return {
      reference: payInReference(data.tx_ref, data.id),
      status: PAYIN_STATUS[data.status] ?? 'pending',
      amount: toKobo(data.amount),
      fee: toKobo((data.app_fee ?? 0) + (data.merchant_fee ?? 0)),
      currency: data.currency,
      channel: intoAccount ? 'dedicated_nuban' : (data.payment_type ?? 'unknown'),
      paidAt: new Date(data.created_at),
      customerCode: intoAccount ? data.tx_ref : undefined,
      senderName: intoAccount ? (data.meta?.originatorname ?? undefined) : undefined,
      senderBank: intoAccount ? (data.meta?.bankname ?? undefined) : undefined,
      isTest: this.#test,
    };
  }

  #requireTestKey(): void {
    if (!this.#test) throw new AppError(403, 'test_mode_only', 'This needs a Flutterwave test key');
  }

  async #data(method: string, path: string, body?: unknown): Promise<unknown> {
    return (await this.#call(method, path, body)).data;
  }

  async #call(method: string, path: string, body?: unknown): Promise<{ data: unknown; meta: unknown }> {
    const { status, body: raw } = await callProvider(PROVIDER, this.#options.baseUrl + path, {
      method,
      headers: { authorization: `Bearer ${this.#options.secretKey}` },
      body,
      timeoutMs: this.#options.timeoutMs,
    });
    const parsed = envelope.safeParse(raw);
    if (!parsed.success)
      throw new ProviderError(PROVIDER, 'unknown', 'Flutterwave sent an unexpected answer', status);
    if (status >= 400 || parsed.data.status !== 'success') {
      const message = parsed.data.message || 'Flutterwave refused the request';
      // A reused reference means an earlier request arrived, so the truth has to be looked up.
      const kind = /ref already exists/i.test(message)
        ? 'unknown'
        : status === 404 || /no transaction was found/i.test(message)
          ? 'not_found'
          : 'rejected';
      throw new ProviderError(PROVIDER, kind, message, status);
    }
    return { data: parsed.data.data, meta: parsed.data.meta };
  }
}

const isOurs = (txRef: string) => txRef.startsWith(PAY_IN_PREFIX) || txRef.startsWith(ACCOUNT_PREFIX);

/** A salary account reference repeats with every payment, so those are told apart by transaction. */
const payInReference = (txRef: string, id: number) => (txRef.startsWith(PAY_IN_PREFIX) ? txRef : `flw-${id}`);

function toTransfer(raw: unknown): TransferResult {
  const data = transferData.parse(raw);
  return {
    reference: data.reference.replace(MOCK_ENDING, ''),
    outcome: TRANSFER_OUTCOMES[data.status] ?? 'pending',
    providerCode: String(data.id),
    reason: data.complete_message || undefined,
    blockedReason:
      data.requires_approval === 1 && data.is_approved === 0
        ? 'Flutterwave is waiting for approval. Turn off transfer approval in the dashboard.'
        : undefined,
    amount: toKobo(data.amount),
    fee: toKobo(data.fee ?? 0),
  };
}
