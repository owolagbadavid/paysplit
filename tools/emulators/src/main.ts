import { startEmulators } from './server.ts';

const emulators = await startEmulators({
  port: Number(process.env.PORT ?? 4010),
  webhookUrl: process.env.WEBHOOK_URL ?? 'http://localhost:4000/webhooks/payments',
});
console.log(`Paystack and Dojah emulators on ${emulators.url}`);
