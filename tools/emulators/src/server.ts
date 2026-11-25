import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';

/**
 * Local stand-ins for the Paystack and Dojah sandboxes, speaking their HTTP protocols. PaySplit itself has no mock
 * mode: it always uses its real adapters, and only the base URL points here during tests and offline work.
 */

export interface TransferRecord {
  reference: string;
  amount: number;
  recipient: string;
  reason: string;
  status: string;
  transfer_code: string;
  gateway_response: string | null;
  fee_charged: number;
}

interface PayInRecord {
  id: number;
  reference: string;
  status: string;
  amount: number;
  fees: number;
  currency: string;
  channel: string;
  domain: string;
  paid_at: string;
  created_at: string;
  metadata: unknown;
  customer: { email: string; customer_code: string };
  authorization: {
    receiver_bank_account_number: string | null;
    sender_name: string | null;
    sender_bank: string | null;
  };
}

export type Fault =
  /** The request is dropped before anything happens. */
  | 'drop_before'
  /** The transfer is recorded, then the answer is lost. */
  | 'drop_after'
  | 'server_error'
  | 'throttle'
  | 'insufficient_balance';

export interface EmulatorOptions {
  port?: number;
  secretKey?: string;
  webhookUrl?: string;
  /** Off in tests that deliver webhooks themselves. */
  autoWebhooks?: boolean;
}

export interface Emulators {
  url: string;
  transfers: Map<string, TransferRecord>;
  payIns: Map<string, PayInRecord>;
  /** Faults consumed one per POST /transfer. */
  transferFaults: Fault[];
  /** Outcome for transfers to an account number ending in these digits is 'failed' or 'pending'. */
  state: { dojahDown: boolean; paystackDown: boolean; transferPosts: number; balance: number };
  /** Simulates a bank transfer into a dedicated account, as Paystack's demo bank does. */
  bankTransfer(accountNumber: string, amount: number, sender?: string): PayInRecord;
  setTransferStatus(reference: string, status: string, reason?: string): void;
  sign(body: string): string;
  webhookBody(event: string, reference: string): string;
  reset(): void;
  close(): Promise<void>;
}

const BANKS = [
  { name: 'Access Bank', code: '044' },
  { name: 'First Bank of Nigeria', code: '011' },
  { name: 'Guaranty Trust Bank', code: '058' },
  { name: 'Kuda Bank', code: '50211' },
  { name: 'OPay Digital Services Limited (OPay)', code: '999992' },
  { name: 'Test Bank', code: '001' },
  { name: 'United Bank For Africa', code: '033' },
  { name: 'Wema Bank', code: '035' },
  { name: 'Zenith Bank', code: '057' },
];
const NAMES = ['FUNKE ADEBAYO', 'GLORY ADEBAYO', 'ALI DABBS', 'CHIDI OKAFOR', 'AMINA BELLO', 'TUNDE BAKARE'];

/** The emulator decides by the account number's last digits: 00 fails, 99 stays pending, 13 is unknown. */
const outcomeFor = (account: string) =>
  account.endsWith('00') ? 'failed' : account.endsWith('99') ? 'pending' : 'success';

async function readBody(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

export async function startEmulators(options: EmulatorOptions = {}): Promise<Emulators> {
  const secretKey = options.secretKey ?? 'sk_test_emulator';
  const customers = new Map<
    string,
    { customer_code: string; email: string; first_name: string; last_name: string; account?: any }
  >();
  const recipients = new Map<string, { account_number: string; bank_code: string; name: string }>();
  const transfers = new Map<string, TransferRecord>();
  const payIns = new Map<string, PayInRecord>();
  const transferFaults: Fault[] = [];
  const state = { dojahDown: false, paystackDown: false, transferPosts: 0, balance: 0 };
  // Starts from the clock, so a restart never reuses an ID the database already holds.
  let sequence = Date.now();

  const sign = (body: string) => createHmac('sha512', secretKey).update(body).digest('hex');
  const webhookBody = (event: string, reference: string) =>
    JSON.stringify({
      event,
      data: event.startsWith('charge.') ? payIns.get(reference) : transfers.get(reference),
    });

  function deliver(event: string, reference: string): void {
    if (!options.webhookUrl || options.autoWebhooks === false) return;
    const body = webhookBody(event, reference);
    setTimeout(() => {
      fetch(options.webhookUrl!, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-paystack-signature': sign(body) },
        body,
      }).catch(() => {});
    }, 400);
  }

  function recordPayIn(input: {
    reference: string;
    amount: number;
    channel: string;
    email: string;
    customerCode: string;
    metadata?: unknown;
    receiver?: string;
    sender?: string;
  }) {
    const now = new Date().toISOString();
    const record: PayInRecord = {
      id: sequence++,
      reference: input.reference,
      status: 'success',
      amount: input.amount,
      fees: Math.min(30_000, Math.ceil(input.amount / 100)),
      currency: 'NGN',
      channel: input.channel,
      domain: 'test',
      paid_at: now,
      created_at: now,
      metadata:
        input.metadata ??
        (input.receiver ? { receiver_account_number: input.receiver, receiver_bank: 'Test Bank' } : ''),
      customer: { email: input.email, customer_code: input.customerCode },
      authorization: {
        receiver_bank_account_number: input.receiver ?? null,
        sender_name: input.sender ?? null,
        sender_bank: input.sender ? 'Demo Bank' : null,
      },
    };
    payIns.set(input.reference, record);
    state.balance += record.amount - record.fees;
    deliver('charge.success', input.reference);
    return record;
  }

  function bankTransfer(accountNumber: string, amount: number, sender = 'TALENT NATION LTD') {
    const customer = [...customers.values()].find((c) => c.account?.account_number === accountNumber);
    return recordPayIn({
      reference: randomUUID().replaceAll('-', ''),
      amount,
      channel: 'dedicated_nuban',
      email: customer?.email ?? 'unknown@example.com',
      customerCode: customer?.customer_code ?? 'CUS_unknown',
      receiver: accountNumber,
      sender,
    });
  }

  function setTransferStatus(reference: string, status: string, reason?: string): void {
    const transfer = transfers.get(reference);
    if (!transfer) throw new Error(`No transfer ${reference}`);
    if (status === 'reversed' && transfer.status === 'success') state.balance += transfer.amount;
    transfer.status = status;
    transfer.gateway_response = reason ?? null;
    if (['success', 'failed', 'reversed'].includes(status)) deliver(`transfer.${status}`, reference);
  }

  type Answer = { status: number; body: unknown } | 'drop';
  const ok = (data: unknown): Answer => ({ status: 200, body: { status: true, message: 'OK', data } });
  const no = (status: number, message: string): Answer => ({ status, body: { status: false, message } });

  async function paystack(request: IncomingMessage, path: string, query: URLSearchParams): Promise<Answer> {
    if (state.paystackDown) return { status: 503, body: { status: false, message: 'Service unavailable' } };
    if (request.headers.authorization !== `Bearer ${secretKey}`) return no(401, 'Invalid key');
    const body = request.method === 'POST' ? await readBody(request) : {};
    const route = `${request.method} ${path}`;

    if (route === 'POST /customer') {
      const existing = customers.get(body.email);
      const customer = existing ?? {
        customer_code: `CUS_${randomUUID().slice(0, 12)}`,
        email: body.email,
        first_name: body.first_name,
        last_name: body.last_name,
      };
      customers.set(body.email, customer);
      return ok({ id: 1, ...customer });
    }
    const customerMatch = /^GET \/customer\/(.+)$/.exec(route);
    if (customerMatch) {
      const customer = [...customers.values()].find(
        (c) => c.customer_code === decodeURIComponent(customerMatch[1]!),
      );
      return customer
        ? ok({ ...customer, dedicated_account: customer.account ?? null })
        : no(404, 'Customer not found');
    }
    if (route === 'POST /dedicated_account') {
      const customer = [...customers.values()].find((c) => c.customer_code === body.customer);
      if (!customer) return no(404, 'Customer not found');
      if (customer.account) return no(400, 'Customer already has a dedicated account');
      customer.account = {
        id: sequence++,
        account_number: `12${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
        account_name: `PAYSPLIT/${customer.first_name} ${customer.last_name}`.toUpperCase(),
        bank: { id: 1, name: 'Test Bank', slug: 'test-bank' },
        assigned: true,
        active: true,
      };
      return ok(customer.account);
    }
    if (route === 'GET /bank') return ok(BANKS.map((b) => ({ ...b, active: true })));
    if (route === 'GET /bank/resolve') {
      const account = query.get('account_number') ?? '';
      if (!/^\d{10}$/.test(account) || account.endsWith('13'))
        return no(422, 'Could not resolve account name. Check parameters or try again.');
      return ok({
        account_number: account,
        account_name: NAMES[Number(account.slice(-3)) % NAMES.length],
        bank_id: 1,
      });
    }
    if (route === 'POST /transferrecipient') {
      const code = `RCP_${randomUUID().slice(0, 12)}`;
      recipients.set(code, {
        account_number: body.account_number,
        bank_code: body.bank_code,
        name: body.name,
      });
      return ok({ recipient_code: code });
    }
    if (route === 'POST /transfer') {
      state.transferPosts++;
      const fault = transferFaults.shift();
      if (fault === 'drop_before') return 'drop';
      if (fault === 'server_error')
        return { status: 500, body: { status: false, message: 'Internal error' } };
      if (fault === 'throttle') return no(429, 'Too many requests');
      if (fault === 'insufficient_balance')
        return no(400, 'Your balance is not enough to fulfil this request');
      if (!/^[a-z0-9_-]{16,50}$/.test(body.reference)) return no(400, 'Invalid transfer reference');
      if (transfers.has(body.reference))
        return no(400, 'Please provide a unique reference. Reference already exists on a transfer');
      const recipient = recipients.get(body.recipient);
      if (!recipient) return no(400, 'Recipient specified is invalid');
      if (body.amount > state.balance) return no(400, 'Your balance is not enough to fulfil this request');
      const status = outcomeFor(recipient.account_number);
      const record: TransferRecord = {
        reference: body.reference,
        amount: body.amount,
        recipient: body.recipient,
        reason: body.reason,
        status,
        transfer_code: `TRF_${randomUUID().slice(0, 12)}`,
        gateway_response: status === 'failed' ? 'Account cannot receive this transfer' : null,
        fee_charged: status === 'success' ? 2500 : 0,
      };
      transfers.set(body.reference, record);
      if (status === 'success') state.balance -= record.amount + record.fee_charged;
      if (status !== 'pending') deliver(`transfer.${status}`, body.reference);
      return fault === 'drop_after' ? 'drop' : ok(record);
    }
    const transferMatch = /^GET \/transfer\/verify\/(.+)$/.exec(route);
    if (transferMatch) {
      const record = transfers.get(decodeURIComponent(transferMatch[1]!));
      return record ? ok(record) : no(404, 'Transfer not found');
    }
    if (route === 'POST /charge') {
      if (payIns.has(body.reference)) return no(400, 'Duplicate Transaction Reference');
      if (body.card?.number !== '4084084084084081') return no(400, 'Declined');
      const customer = customers.get(body.email);
      return ok(
        recordPayIn({
          reference: body.reference,
          amount: body.amount,
          channel: 'card',
          email: body.email,
          customerCode: customer?.customer_code ?? 'CUS_unknown',
          metadata: body.metadata,
        }),
      );
    }
    const verifyMatch = /^GET \/transaction\/verify\/(.+)$/.exec(route);
    if (verifyMatch) {
      const record = payIns.get(decodeURIComponent(verifyMatch[1]!));
      return record ? ok(record) : no(400, 'Transaction reference not found');
    }
    if (route === 'GET /transaction') return ok([...payIns.values()].reverse().slice(0, 100));
    if (route === 'GET /balance') return ok([{ currency: 'NGN', balance: state.balance }]);
    return no(404, `No emulated route ${route}`);
  }

  async function dojah(request: IncomingMessage, path: string, query: URLSearchParams): Promise<Answer> {
    if (state.dojahDown) return { status: 424, body: { error: 'Upstream service failed' } };
    if (!request.headers.authorization || !request.headers.appid)
      return { status: 401, body: { error: 'Unauthorized' } };
    const body = request.method === 'POST' ? await readBody(request) : {};
    const entity = (value: unknown): Answer => ({ status: 200, body: { entity: value } });

    if (path === '/api/v1/kyc/bvn/full') {
      const bvn = query.get('bvn') ?? '';
      return bvn === '22222222222'
        ? entity({ bvn, first_name: 'JOHN', last_name: 'MUSA', gender: 'Male', date_of_birth: '1997-05-16' })
        : { status: 400, body: { error: 'BVN not found' } };
    }
    if (path === '/api/v1/kyc/nin') {
      return query.get('nin') === '70123456789'
        ? entity({ first_name: 'John', last_name: 'Musa', gender: 'Male' })
        : { status: 404, body: { error: 'NIN not found' } };
    }
    if (path === '/api/v1/ml/liveness') {
      const marker = Buffer.from(body.image ?? '', 'base64')
        .toString('latin1')
        .slice(0, 40);
      const noFace = marker.includes('NOFACE');
      const spoof = marker.includes('SPOOF');
      // Dojah's hosted sandbox answers every photo with this.
      if (marker.includes('HOSTED'))
        return entity({
          face: { detected: true, message: 'Face detected' },
          liveness: { spoof: true, confidence: 99.99720001220703 },
        });
      return entity({
        face: {
          face_detected: !noFace,
          multiface_detected: false,
          quality: { brightness: 80, sharpness: 90 },
        },
        liveness: { liveness_check: !spoof && !noFace, liveness_probability: spoof || noFace ? 12 : 98 },
      });
    }
    if (path === '/api/v1/kyc/bvn/verify' || path === '/api/v1/kyc/nin/verify') {
      const mismatch = Buffer.from(body.selfie_image ?? '', 'base64')
        .toString('latin1')
        .slice(0, 40)
        .includes('OTHER');
      return entity({
        first_name: 'JOHN',
        last_name: 'MUSA',
        selfie_verification: mismatch
          ? { confidence_value: 31.2, match: false }
          : { confidence_value: 99.8, match: true },
      });
    }
    return { status: 404, body: { error: 'Not found' } };
  }

  /** Controls for demos: pay a salary in by bank transfer, or change how a transfer ends. */
  async function control(request: IncomingMessage, path: string): Promise<Answer> {
    const body = await readBody(request);
    if (path === '/bank-transfer') return ok(bankTransfer(body.account_number, body.amount, body.sender));
    if (path === '/transfer-status') {
      setTransferStatus(body.reference, body.status, body.reason);
      return ok(transfers.get(body.reference));
    }
    if (path === '/fault') {
      transferFaults.push(body.fault);
      return ok({ queued: transferFaults });
    }
    return no(404, 'Unknown control');
  }

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const [, service, ...rest] = url.pathname.split('/');
    const path = `/${rest.join('/')}`;
    const handle =
      service === 'paystack'
        ? paystack(request, path, url.searchParams)
        : service === 'dojah'
          ? dojah(request, path, url.searchParams)
          : service === 'control'
            ? control(request, path)
            : Promise.resolve(no(404, 'Unknown service'));
    handle.then(
      (answer) => {
        if (answer === 'drop') return request.socket.destroy();
        response
          .writeHead(answer.status, { 'content-type': 'application/json' })
          .end(JSON.stringify(answer.body));
      },
      (error: Error) =>
        response
          .writeHead(500, { 'content-type': 'application/json' })
          .end(JSON.stringify({ status: false, message: error.message })),
    );
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;

  return {
    url: `http://127.0.0.1:${port}`,
    transfers,
    payIns,
    transferFaults,
    state,
    bankTransfer,
    setTransferStatus,
    sign,
    webhookBody,
    reset() {
      customers.clear();
      recipients.clear();
      transfers.clear();
      payIns.clear();
      transferFaults.length = 0;
      Object.assign(state, { dojahDown: false, paystackDown: false, transferPosts: 0, balance: 0 });
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
