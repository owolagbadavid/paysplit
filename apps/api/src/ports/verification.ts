export interface IdentityResult {
  found: boolean;
  firstName?: string | undefined;
  lastName?: string | undefined;
}

export interface LivenessResult {
  /** False when the provider answers every photo the same way, so the verdict says nothing about this one. */
  conclusive: boolean;
  faceDetected: boolean;
  multipleFaces: boolean;
  live: boolean;
  /** 0 to 100. */
  score: number;
}

export interface FaceMatchResult {
  matched: boolean;
  /** 0 to 100. */
  score: number;
}

/** Identity checks for one region. Throws ProviderError when the provider gave no usable answer. */
export interface VerificationProvider {
  readonly name: string;
  readonly identityTypes: readonly string[];
  lookupIdentity(input: { type: string; number: string }): Promise<IdentityResult>;
  checkLiveness(imageBase64: string): Promise<LivenessResult>;
  matchFace(input: { type: string; number: string; imageBase64: string }): Promise<FaceMatchResult>;
}

/** Picks the verification adapter for a person's country, or null where PaySplit has not launched. */
export class RegionRouter {
  readonly #byCountry: ReadonlyMap<string, VerificationProvider>;

  constructor(byCountry: Record<string, VerificationProvider>) {
    this.#byCountry = new Map(Object.entries(byCountry));
  }

  forCountry(country: string | null): VerificationProvider | null {
    return (country && this.#byCountry.get(country)) || null;
  }
}
