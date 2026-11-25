import { writeFileSync } from 'node:fs';
import { buildApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { createContext } from '../create-context.ts';

/** Writes the OpenAPI document generated from the route schemas. */
const { ctx, close } = createContext({ ...loadConfig(), LOG_LEVEL: 'silent' });
const app = await buildApp(ctx);
writeFileSync('openapi.json', `${JSON.stringify(app.swagger(), null, 2)}\n`);
await app.close();
await close();
console.log('openapi.json written');
