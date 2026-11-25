import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

type Row = Record<string, unknown> & { reference?: string };

export interface FakeFlutterwave {
  url: string;
  transfers: Row[];
  transactions: Row[];
  /** Answers the next transfer with an unreadable body after accepting it, as a broken proxy would. */
  loseNextTransferAnswer: boolean;
  /** Pays a salary account the way a bank transfer does. */
  payIntoAccount(txRef: string, naira: number): Row;
  settleTransfers(): void;
  close(): Promise<void>;
}

/** Speaks Flutterwave v3 with the bodies its real test mode sent on 2026-11-25. */
export async function startFakeFlutterwave(): Promise<FakeFlutterwave> {
  let nextId = 100;
  const beneficiaries: Row[] = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1,
    account_number: `06900000${10 + i}`,
    bank_code: '044',
    full_name: 'Other App',
    bank_name: 'ACCESS BANK NIGERIA',
  }));
  const fake: FakeFlutterwave = {
    url: '',
    transfers: [],
    transactions: [],
    loseNextTransferAnswer: false,
    payIntoAccount(txRef, naira) {
      const row = transaction(txRef, naira);
      fake.transactions.push(row);
      return row;
    },
    settleTransfers() {
      for (const t of fake.transfers) {
        const reference = t.reference!;
        if (reference.endsWith('_PMCKDU_1')) t.status = 'SUCCESSFUL';
        if (reference.endsWith('_PMCKDU_ST_FDU_1')) {
          t.status = 'FAILED';
          t.complete_message = 'DISBURSE FAILED: Transfer failed. Please contact support';
        }
      }
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  const transaction = (txRef: string, amount: number): Row => ({
    id: ++nextId,
    tx_ref: txRef,
    amount,
    app_fee: 70,
    merchant_fee: 0,
    currency: 'NGN',
    status: 'successful',
    payment_type: 'bank_transfer',
    created_at: new Date().toISOString(),
    meta: { virtualaccountnumber: '0067100155', originatorname: 'JOHN DOE', bankname: 'Access Bank' },
    customer: { email: 'someone@example.com' },
  });

  const ok = (data: unknown, meta?: unknown) => ({ status: 200, body: { status: 'success', data, meta } });
  const no = (status: number, message: string) => ({
    status,
    body: { status: 'error', message, data: null },
  });

  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://fake');
    const body = request.method === 'POST' ? await read(request) : {};
    let answer: { status: number; body: unknown };
    if (request.method === 'POST' && url.pathname === '/accounts/resolve')
      answer = no(503, 'An error occurred. Please contact support');
    else if (url.pathname === '/banks/NG')
      answer = ok([
        { id: 1, code: '044', name: 'Access Bank ' },
        { id: 2, code: '058', name: 'GTBank Plc' },
      ]);
    else if (url.pathname === '/virtual-account-numbers')
      answer = body.bvn
        ? ok({
            order_ref: `URF_${++nextId}`,
            account_number: '0067100155',
            bank_name: 'Mock Bank',
            account_status: 'active',
          })
        : no(400, 'BVN or NIN is required for static account number');
    else if (request.method === 'POST' && url.pathname === '/beneficiaries') {
      const known = beneficiaries.some(
        (b) => b.account_number === body.account_number && b.bank_code === body.account_bank,
      );
      if (known) answer = no(400, 'Beneficiary already added to your account');
      else {
        const row = {
          id: ++nextId,
          account_number: body.account_number,
          bank_code: body.account_bank,
          full_name: 'Pastor Bright',
          bank_name: 'ACCESS BANK NIGERIA',
        };
        beneficiaries.push(row);
        answer = ok(row);
      }
    } else if (url.pathname === '/beneficiaries') {
      const page = Number(url.searchParams.get('page'));
      answer = ok(beneficiaries.slice((page - 1) * 10, page * 10), {
        page_info: { total_pages: Math.ceil(beneficiaries.length / 10) },
      });
    } else if (request.method === 'POST' && url.pathname === '/transfers') {
      if (fake.transfers.some((t) => t.reference === body.reference))
        answer = no(400, 'Payout with this ref already exists');
      else {
        const row = {
          id: ++nextId,
          reference: body.reference,
          amount: body.amount,
          fee: 10.75,
          status: 'NEW',
          complete_message: '',
          requires_approval: 0,
          is_approved: 1,
          beneficiary: body.beneficiary,
        };
        fake.transfers.push(row);
        answer = ok(row);
        if (fake.loseNextTransferAnswer) {
          fake.loseNextTransferAnswer = false;
          answer = { status: 200, body: 'upstream connect error or disconnect/reset before headers' };
        }
      }
    } else if (url.pathname === '/transfers')
      answer = ok(
        fake.transfers.filter((t) => t.reference === url.searchParams.get('reference')),
        { page_info: { total_pages: 1 } },
      );
    else if (url.pathname === '/charges') {
      // Direct charges can be verified, but the real list leaves them out.
      fake.transactions.push({ ...transaction(body.tx_ref, body.amount), unlisted: true });
      answer = ok(undefined, { authorization: { mode: 'banktransfer' } });
    } else if (url.pathname === '/transactions/verify_by_reference') {
      const row = fake.transactions.find((t) => t.tx_ref === url.searchParams.get('tx_ref'));
      answer = row ? ok(row) : no(400, 'No transaction was found for this id');
    } else if (/^\/transactions\/\d+\/verify$/.test(url.pathname)) {
      const row = fake.transactions.find((t) => String(t.id) === url.pathname.split('/')[2]);
      answer = row ? ok(row) : no(400, 'No transaction was found for this id');
    } else if (url.pathname === '/transactions')
      answer = ok(
        fake.transactions.filter((t) => !t.unlisted),
        { page_info: { total_pages: 1 } },
      );
    else if (url.pathname === '/balances/NGN') answer = ok({ available_balance: 6637.8 });
    else answer = no(404, 'Not found');
    response.writeHead(answer.status, { 'content-type': 'application/json' });
    response.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

async function read(request: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
