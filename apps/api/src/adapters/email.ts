import nodemailer from 'nodemailer';
import { ProviderError } from '../lib/errors.ts';
import { callProvider } from '../lib/http.ts';
import type { EmailSender, OutgoingEmail } from '../ports/email.ts';

export class SmtpSender implements EmailSender {
  readonly #transport;
  readonly #from: string;

  constructor(url: string, from: string) {
    this.#transport = nodemailer.createTransport(url);
    this.#from = from;
  }

  async send(email: OutgoingEmail) {
    await this.#transport.sendMail({ from: this.#from, ...email });
  }
}

/** Brevo over HTTPS, for hosts that block every outbound SMTP port. */
export class BrevoSender implements EmailSender {
  readonly #apiKey: string;
  readonly #sender: { name: string; email: string };

  constructor(apiKey: string, from: string) {
    const match = /^(.*?)\s*<(.+)>$/.exec(from);
    this.#apiKey = apiKey;
    this.#sender = { name: match?.[1] || 'PaySplit', email: match?.[2] ?? from };
  }

  async send(email: OutgoingEmail) {
    const { status } = await callProvider('brevo', 'https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': this.#apiKey },
      body: {
        sender: this.#sender,
        to: [{ email: email.to }],
        subject: email.subject,
        htmlContent: email.html,
        textContent: email.text,
      },
      timeoutMs: 15_000,
    });
    if (status >= 400)
      throw new ProviderError('brevo', 'rejected', `Brevo refused the email (${status})`, status);
  }
}
