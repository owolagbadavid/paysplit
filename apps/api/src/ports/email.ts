export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailSender {
  send(email: OutgoingEmail): Promise<void>;
}
