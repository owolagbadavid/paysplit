/** A normalized outcome every provider maps to. `pending` covers anything not yet final. */
export type TransferOutcome = 'pending' | 'success' | 'failed' | 'reversed';

export interface TransferResult {
  reference: string;
  outcome: TransferOutcome;
  providerCode?: string | undefined;
  reason?: string | undefined;
  /** Set when a person has to act at the provider before the transfer can move, such as approving an OTP. */
  blockedReason?: string | undefined;
  amount: bigint;
  fee: bigint;
}

export interface PayIn {
  reference: string;
  status: 'pending' | 'success' | 'failed' | 'reversed';
  amount: bigint;
  fee: bigint;
  currency: string;
  channel: string;
  paidAt: Date;
  /** Collection account that received it, when it arrived by bank transfer. */
  receiverAccountNumber?: string | undefined;
  customerCode?: string | undefined;
  senderName?: string | undefined;
  senderBank?: string | undefined;
  isTest: boolean;
}

export interface CollectionAccount {
  customerCode: string;
  accountId: string;
  accountNumber: string;
  accountName: string;
  bankName: string;
}

export interface Bank {
  code: string;
  name: string;
}

/** What a webhook tells us to go and look up. Its own claims about money are never trusted. */
export type PaymentEvent =
  | { kind: 'payin'; type: string; reference: string }
  | { kind: 'transfer'; type: string; reference: string }
  | { kind: 'ignored'; type: string; reference?: string | undefined };

/** Everything PaySplit needs from a payment rail. The split engine, ledger and scheduler only know this. */
export interface PaymentProvider {
  readonly name: string;
  /** `reference` is the same for one person every time, so a repeat leads back to the same account. */
  provisionCollectionAccount(input: {
    reference: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string;
  }): Promise<CollectionAccount>;
  listBanks(): Promise<Bank[]>;
  resolveAccount(bankCode: string, accountNumber: string): Promise<{ accountName: string }>;
  createRecipient(input: {
    name: string;
    bankCode: string;
    accountNumber: string;
  }): Promise<{ recipientCode: string }>;
  /** `reference` is the provider's idempotency key: the same one can never move money twice. */
  initiateTransfer(input: {
    reference: string;
    amount: bigint;
    recipientCode: string;
    narration: string;
  }): Promise<TransferResult>;
  /** Throws ProviderError `not_found` when the provider has never seen the reference. */
  getTransfer(reference: string): Promise<TransferResult>;
  getPayIn(reference: string): Promise<PayIn>;
  listPayIns(input: { from: Date; to: Date }): Promise<PayIn[]>;
  /** Sends a salary through the provider's own sandbox rails. Test mode only. */
  submitTestPayIn(input: {
    reference: string;
    amount: bigint;
    email: string;
    metadata: Record<string, string>;
  }): Promise<PayIn>;
  getBalance(currency: string): Promise<bigint>;
  /** Throws when the signature does not match the exact bytes received. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): PaymentEvent;
}
