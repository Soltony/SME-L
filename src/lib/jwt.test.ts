import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encryptJwt, resetSigningKey, verifyJwt } from './jwt';
import { resetSecretCache } from './secrets';

const SECRET = 'test-session-secret-of-sufficient-length-0123456789';
const OTHER_SECRET = 'a-completely-different-secret-of-sufficient-length-9876';

const key = (value: string) => new TextEncoder().encode(value);

beforeEach(() => {
  process.env.SESSION_SECRET = SECRET;
  resetSecretCache();
  resetSigningKey();
});

afterEach(() => {
  delete process.env.SESSION_SECRET;
  resetSecretCache();
  resetSigningKey();
});

const b64url = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/** A token whose signature is genuine but whose expiry is in the past. */
function signedWith(secret: string, claims: Record<string, unknown>, exp: number | string) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(key(secret));
}

/** Re-encodes a token's payload, leaving the original signature in place. */
function editPayload(token: string, changes: Record<string, unknown>) {
  const [header, payload, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  return [header, b64url({ ...claims, ...changes }), signature].join('.');
}

describe('verifyJwt', () => {
  it('accepts a token we issued that is still within its window', async () => {
    const token = await encryptJwt({ userId: 'u1', sessionId: 's1' }, '15m');
    const result = await verifyJwt<{ userId: string; sessionId: string }>(token);

    expect(result.status).toBe('valid');
    if (result.status !== 'valid') return;
    expect(result.payload.userId).toBe('u1');
    expect(result.payload.sessionId).toBe('s1');
  });

  it('reports a genuine but aged token as expired, with its claims intact', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const token = await signedWith(SECRET, { userId: 'u1', sessionId: 's1' }, past);
    const result = await verifyJwt<{ sessionId: string }>(token);

    // Expired is recoverable — this is the token a live session renews from.
    expect(result.status).toBe('expired');
    if (result.status !== 'expired') return;
    expect(result.payload.sessionId).toBe('s1');
  });

  it('rejects a token whose payload has been edited', async () => {
    const token = await encryptJwt({ userId: 'u1', sessionId: 's1' }, '15m');
    const forged = editPayload(token, { userId: 'someone-else' });

    expect((await verifyJwt(forged)).status).toBe('invalid');
  });

  it('rejects a token whose signature has been altered', async () => {
    const token = await encryptJwt({ userId: 'u1', sessionId: 's1' }, '15m');
    const [header, payload, signature] = token.split('.');
    const flipped = signature[0] === 'A' ? 'B' : 'A';
    const tampered = [header, payload, flipped + signature.slice(1)].join('.');

    expect((await verifyJwt(tampered)).status).toBe('invalid');
  });

  /**
   * The regression this file exists for.
   *
   * An edited token whose expiry has also passed must not come back `expired`.
   * That verdict is what the session code renews from, so reporting it here
   * would hand a freshly signed token to whoever did the editing — the session
   * would repair itself instead of ending.
   */
  it('rejects an edited token even when it is also expired', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const token = await signedWith(SECRET, { userId: 'u1', sessionId: 's1' }, past);
    const forged = editPayload(token, { sessionId: 's1', userId: 'u1', extra: 'x' });

    const result = await verifyJwt(forged);
    expect(result.status).toBe('invalid');
    expect(result.status).not.toBe('expired');
  });

  it('rejects a token signed with a different key', async () => {
    const token = await signedWith(OTHER_SECRET, { userId: 'u1' }, '15m');
    expect((await verifyJwt(token)).status).toBe('invalid');
  });

  it('rejects an unsigned token claiming alg none', async () => {
    const forged = [
      b64url({ alg: 'none' }),
      b64url({ userId: 'u1', sessionId: 's1', exp: Math.floor(Date.now() / 1000) + 900 }),
      '',
    ].join('.');

    expect((await verifyJwt(forged)).status).toBe('invalid');
  });

  it('rejects a signed token that carries no expiry', async () => {
    // Every token this app mints sets one, so its absence means the token is
    // not ours — it must not be read as "never expires".
    const token = await new SignJWT({ userId: 'u1', sessionId: 's1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .sign(key(SECRET));

    expect((await verifyJwt(token)).status).toBe('invalid');
  });

  it('rejects malformed input rather than throwing', async () => {
    for (const value of ['', 'not-a-token', 'a.b', 'a.b.c', '...', 'eyJhbGciOiJIUzI1NiJ9']) {
      expect((await verifyJwt(value)).status).toBe('invalid');
    }
  });
});
