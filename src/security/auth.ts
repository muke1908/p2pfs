import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export const secret = () => randomBytes(32).toString('base64url');
export const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export async function passwordHash(password: string): Promise<string> {
  if (password.length < 12 || password.length > 1024)
    throw new AppError(
      400,
      'Use a host password between 12 and 1024 characters.',
    );
  const salt = randomBytes(16).toString('hex');
  const key = (await derive(password, salt, 64)) as Buffer;
  return `${salt}:${key.toString('hex')}`;
}

export async function verifyPassword(
  password: string,
  verifier: string,
): Promise<boolean> {
  const [salt, encoded] = verifier.split(':');
  if (!salt || !encoded || password.length > 1024) return false;
  const expected = Buffer.from(encoded, 'hex');
  const actual = (await derive(password, salt, 64)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export class Sessions {
  private entries = new Map<string, number>();
  private attempts: number[] = [];
  private active = 0;
  constructor(
    private verifier: string,
    private lifetime = 60 * 60 * 1000,
  ) {}

  async login(password: string): Promise<string> {
    const now = Date.now();
    this.attempts = this.attempts.filter((time) => now - time < 60_000);
    this.prune();
    if (
      this.active >= 2 ||
      this.attempts.length >= 20 ||
      this.entries.size >= 1000
    )
      throw new AppError(429, 'Login capacity exceeded; retry later.');
    this.attempts.push(now);
    this.active++;
    try {
      if (!(await verifyPassword(password, this.verifier)))
        throw new AppError(401, 'Invalid password.');
      const token = secret();
      this.entries.set(digest(token), Date.now() + this.lifetime);
      return token;
    } finally {
      this.active--;
    }
  }

  require(token: string | undefined): void {
    const key = digest(token ?? '');
    if (!this.valid(token)) {
      this.entries.delete(key);
      throw new AppError(401, 'Authentication required or session expired.');
    }
  }

  valid(token: string | undefined): boolean {
    return (this.entries.get(digest(token ?? '')) ?? 0) > Date.now();
  }

  logout(token: string): void {
    this.entries.delete(digest(token));
  }

  private prune(): void {
    for (const [key, expiry] of this.entries)
      if (expiry <= Date.now()) this.entries.delete(key);
  }
}
