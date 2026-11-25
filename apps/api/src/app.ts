import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import * as Sentry from '@sentry/node';
import Fastify from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Ctx } from './context.ts';
import { AppError, ProviderError } from './lib/errors.ts';
import { adminRoutes } from './routes/admin.ts';
import { authRoutes } from './routes/auth.ts';
import { customerRoutes } from './routes/customer.ts';
import { systemRoutes } from './routes/system.ts';
import type { App } from './routes/support.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function buildApp(ctx: Ctx): Promise<App> {
  const app = Fastify({
    loggerInstance: ctx.log,
    trustProxy: ctx.config.isProduction ? (_address, hop) => hop < ctx.config.PROXY_HOPS : false,
    bodyLimit: 200_000,
    genReqId: () => crypto.randomUUID(),
  }).withTypeProvider<ZodTypeProvider>() as unknown as App;

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('auth', null as never);
  app.addHook('onRequest', async (request) => {
    request.auth = {};
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: ctx.config.isProduction ? [] : null,
      },
    },
  });
  app.addHook('onSend', async (request, reply) => {
    reply.header('permissions-policy', 'camera=(self), microphone=(), geolocation=()');
    if (request.url.startsWith('/v1/')) reply.header('cache-control', 'no-store');
  });
  await app.register(cookie);
  if (ctx.config.RATE_LIMITS) {
    await app.register(rateLimit, {
      max: 300,
      timeWindow: '1 minute',
      errorResponseBuilder: () =>
        new AppError(429, 'too_many_requests', 'Too many requests. Wait a minute and try again.'),
    });
  }

  // Cookies authenticate the browser, so state changes also need a header other sites cannot set and, when the
  // browser names an origin, our own.
  const allowedOrigin = new URL(ctx.config.APP_URL).origin;
  app.addHook('preHandler', async (request) => {
    if (SAFE_METHODS.has(request.method) || !request.url.startsWith('/v1/')) return;
    const origin = request.headers.origin;
    if (
      request.headers['x-paysplit-client'] === undefined ||
      (origin !== undefined && origin !== allowedOrigin)
    ) {
      throw new AppError(403, 'cross_site_request', 'This request did not come from PaySplit');
    }
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'PaySplit API',
        version: '1.0.0',
        description:
          'Amounts are integers in kobo. Percentages are basis points. Sign in sets an HttpOnly cookie. State-changing requests need the `X-PaySplit-Client` header, and those that move money need an `Idempotency-Key`.',
      },
      components: {
        securitySchemes: {
          userSession: { type: 'apiKey', in: 'cookie', name: 'ps_session' },
          adminSession: { type: 'apiKey', in: 'cookie', name: 'ps_admin' },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs', staticCSP: true });

  app.setErrorHandler((error, request, reply) => {
    const send = (status: number, code: string, message: string, details?: unknown) =>
      reply.status(status).send({
        error: { code, message, ...(details === undefined ? {} : { details }) },
        requestId: request.id,
      });

    if (error instanceof AppError) return send(error.status, error.code, error.message, error.details);
    if (hasZodFastifySchemaValidationErrors(error)) {
      const fields: Record<string, string> = {};
      for (const issue of error.validation)
        fields[issue.instancePath.replace(/^\//, '').replaceAll('/', '.') || 'form'] ??=
          issue.message ?? 'Invalid value';
      return send(400, 'validation_failed', Object.values(fields)[0] ?? 'Check the form and try again', {
        fields,
      });
    }
    if (error instanceof ProviderError) {
      request.log.warn({ err: error }, 'provider error reached a request');
      return send(503, 'provider_unavailable', 'A partner service is not responding. Try again shortly.');
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500)
      return send(
        status,
        'bad_request',
        status === 413 ? 'That upload is too large' : 'The request could not be read',
      );
    request.log.error({ err: error }, 'unhandled error');
    Sentry.captureException(error, { tags: { requestId: request.id } });
    return send(500, 'internal_error', 'Something went wrong on our side. Try again.');
  });

  systemRoutes(app, ctx);
  authRoutes(app, ctx);
  customerRoutes(app, ctx);
  adminRoutes(app, ctx);

  const webDist = ctx.config.WEB_DIST;
  const serveWeb = webDist !== undefined && existsSync(join(webDist, 'index.html'));
  if (serveWeb) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      setHeaders: (reply, path) => {
        reply.header(
          'cache-control',
          path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
  }
  app.setNotFoundHandler((request, reply) => {
    const isApi = /^\/(v1|webhooks|internal)\//.test(request.url);
    if (serveWeb && !isApi && (request.method === 'GET' || request.method === 'HEAD'))
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    return reply
      .status(404)
      .send({ error: { code: 'not_found', message: 'Nothing here' }, requestId: request.id });
  });

  await app.ready();
  return app;
}
