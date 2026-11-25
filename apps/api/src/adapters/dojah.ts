import { z } from 'zod';
import { ProviderError } from '../lib/errors.ts';
import { callProvider } from '../lib/http.ts';
import type {
  FaceMatchResult,
  IdentityResult,
  LivenessResult,
  VerificationProvider,
} from '../ports/verification.ts';

const PROVIDER = 'dojah';

const livenessSchema = z
  .object({
    face: z
      .object({
        face_detected: z.boolean().optional(),
        detected: z.boolean().optional(),
        multiface_detected: z.boolean().default(false),
      })
      .loose(),
    // The documented answer comes first. The sandbox sends the second one.
    liveness: z
      .union([
        z.object({ liveness_check: z.boolean(), liveness_probability: z.number() }),
        z.object({ spoof: z.boolean(), confidence: z.number() }),
      ])
      .optional(),
  })
  .loose();

export interface DojahOptions {
  appId: string;
  secretKey: string;
  baseUrl: string;
  matchThreshold: number;
  livenessThreshold: number;
  /** Dojah's hosted sandbox sends one fixed liveness answer whatever the photo is. */
  fixedLiveness: boolean;
}

/** Nigerian identity and liveness checks over Dojah. Photos pass through and are never stored. */
export class DojahProvider implements VerificationProvider {
  readonly name = PROVIDER;
  readonly identityTypes = ['bvn', 'nin'] as const;
  readonly #options: DojahOptions;

  constructor(options: DojahOptions) {
    this.#options = options;
  }

  async lookupIdentity(input: { type: string; number: string }): Promise<IdentityResult> {
    const path =
      input.type === 'bvn'
        ? `/api/v1/kyc/bvn/full?bvn=${input.number}`
        : `/api/v1/kyc/nin?nin=${input.number}`;
    const raw = await this.#call('GET', path);
    if (raw === null) return { found: false };
    const entity = z
      .object({ first_name: z.string().nullish(), last_name: z.string().nullish() })
      .loose()
      .parse(raw);
    return {
      found: true,
      firstName: entity.first_name ?? undefined,
      lastName: entity.last_name ?? undefined,
    };
  }

  async checkLiveness(imageBase64: string): Promise<LivenessResult> {
    const parsed = livenessSchema.safeParse(
      await this.#call('POST', '/api/v1/ml/liveness', { image: imageBase64 }),
    );
    if (!parsed.success)
      throw new ProviderError(PROVIDER, 'unknown', 'Dojah sent an unexpected liveness answer');
    const { face, liveness } = parsed.data;
    const faceDetected = face.face_detected ?? face.detected ?? false;
    if (!liveness && faceDetected)
      throw new ProviderError(PROVIDER, 'unknown', 'Dojah sent no liveness verdict');
    const score = !liveness
      ? 0
      : 'spoof' in liveness
        ? liveness.spoof
          ? 100 - liveness.confidence
          : liveness.confidence
        : liveness.liveness_probability;
    const passed = !!liveness && ('spoof' in liveness ? !liveness.spoof : liveness.liveness_check);
    return {
      conclusive: !this.#options.fixedLiveness,
      faceDetected,
      multipleFaces: face.multiface_detected,
      live: passed && score >= this.#options.livenessThreshold,
      score,
    };
  }

  async matchFace(input: { type: string; number: string; imageBase64: string }): Promise<FaceMatchResult> {
    const raw = await this.#call('POST', `/api/v1/kyc/${input.type === 'bvn' ? 'bvn' : 'nin'}/verify`, {
      [input.type]: input.number,
      selfie_image: input.imageBase64,
      threshold: this.#options.matchThreshold,
    });
    const { selfie_verification: result } = z
      .object({ selfie_verification: z.object({ confidence_value: z.number(), match: z.boolean() }) })
      .loose()
      .parse(raw);
    return { matched: result.match, score: result.confidence_value };
  }

  /** Returns `entity`, or null when Dojah has no record of the identifier. */
  async #call(method: string, path: string, body?: unknown): Promise<unknown> {
    const { status, body: raw } = await callProvider(PROVIDER, this.#options.baseUrl + path, {
      method,
      headers: { authorization: this.#options.secretKey, appid: this.#options.appId },
      body,
      timeoutMs: 30_000,
    });
    const error = z.object({ error: z.unknown().optional() }).safeParse(raw).data?.error;
    const message = typeof error === 'string' ? error : 'Dojah refused the request';
    if (status === 404 || (status === 400 && /not found/i.test(message))) return null;
    // 424 is an upstream registry outage and 402 is our own wallet: neither says anything about the person.
    if ([401, 402, 403, 424].includes(status))
      throw new ProviderError(PROVIDER, 'unknown', `Dojah could not check this (${status})`, status);
    if (status >= 400) throw new ProviderError(PROVIDER, 'rejected', message, status);
    const entity = z.object({ entity: z.unknown().optional() }).safeParse(raw);
    if (!entity.success || entity.data.entity == null)
      throw new ProviderError(PROVIDER, 'unknown', 'Dojah sent an unexpected answer', status);
    return entity.data.entity;
  }
}
