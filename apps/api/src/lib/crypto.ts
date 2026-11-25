import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** AES-256-GCM for personal data at rest, and keyed fingerprints for detecting reuse without storing the value. */
export class Vault {
  readonly #key: Buffer;
  readonly #fingerprintKey: string;

  constructor(encryptionKeyBase64: string, fingerprintKey: string) {
    this.#key = Buffer.from(encryptionKeyBase64, 'base64');
    this.#fingerprintKey = fingerprintKey;
  }

  /** `context` is authenticated, so a ciphertext copied onto another record fails to decrypt. */
  encrypt(plain: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv).setAAD(Buffer.from(context));
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      body.toString('base64'),
    ].join(':');
  }

  decrypt(stored: string, context: string): string {
    const [version, iv, tag, body] = stored.split(':');
    if (version !== 'v1' || !iv || !tag || !body) throw new Error('Unreadable ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(iv, 'base64'))
      .setAAD(Buffer.from(context))
      .setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
  }

  fingerprint(kind: string, value: string): string {
    return createHmac('sha256', this.#fingerprintKey).update(`${kind}:${value}`).digest('hex');
  }
}
