import { randomBytes } from "node:crypto";

type PairingSecret = { baseUrl: string; token: string; expiresAt: number };

export class PairingStore {
  private readonly values = new Map<string, PairingSecret>();

  constructor(
    private readonly makeCode = () => randomBytes(24).toString("base64url"),
    private readonly now = () => Date.now(),
    private readonly ttlMs = 5 * 60_000,
  ) {}

  create(baseUrl: string, token: string) {
    this.prune();
    const code = this.makeCode();
    const expiresAt = this.now() + this.ttlMs;
    this.values.set(code, { baseUrl, token, expiresAt });
    const query = new URLSearchParams({ url: baseUrl, code });
    return { payload: `codex-remote://pair?${query.toString()}`, expiresAt };
  }

  consume(code: string) {
    const value = this.values.get(code);
    this.values.delete(code);
    if (!value || value.expiresAt < this.now()) return undefined;
    return { baseUrl: value.baseUrl, token: value.token };
  }

  private prune() {
    const now = this.now();
    for (const [code, value] of this.values) {
      if (value.expiresAt < now) this.values.delete(code);
    }
  }
}
