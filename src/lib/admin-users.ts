import bcrypt from 'bcryptjs';
import { securePick, secureShuffle } from './random';

export const PASSWORD_MIN_LENGTH = 12;

/**
 * Passwords that satisfy every complexity rule and are still the first thing
 * anybody tries.
 *
 * Length and character-class rules are necessary and not sufficient:
 * `Password1!` and `Admin@1234` clear all four classes and sit near the top of
 * every credential-stuffing list. Compared case-insensitively and with trailing
 * digits and punctuation stripped, so `password123!` and `Password1!` are both
 * caught by the single entry `password`.
 */
const COMMON_PASSWORDS = new Set([
  'password',
  'passw0rd',
  'p@ssword',
  'p@ssw0rd',
  'admin',
  'administrator',
  'superadmin',
  'welcome',
  'letmein',
  'qwerty',
  'qwertyui',
  'asdfgh',
  'zxcvbn',
  'iloveyou',
  'monkey',
  'dragon',
  'sunshine',
  'princess',
  'football',
  'baseball',
  'master',
  'shadow',
  'trustno',
  'changeme',
  'secret',
  'login',
  'abc',
  'test',
  'guest',
  'default',
  'root',
  'lending',
  'loan',
  'borrower',
]);

/** Keyboard runs and digit sequences, forwards or backwards. */
const SEQUENCES = ['abcdefghijklmnopqrstuvwxyz', '0123456789', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

/** `Password123!` → `password`, so one list entry covers a family of variants. */
function passwordStem(password: string): string {
  return password
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/[0-9]+$/, '');
}

function hasLongRun(password: string): boolean {
  // Four or more of the same character: `aaaa`, `1111`.
  return /(.)\1{3,}/.test(password);
}

function hasSequence(password: string): boolean {
  const lower = password.toLowerCase();
  for (const row of SEQUENCES) {
    for (let i = 0; i + 4 <= row.length; i += 1) {
      const run = row.slice(i, i + 4);
      if (lower.includes(run) || lower.includes([...run].reverse().join(''))) return true;
    }
  }
  return false;
}

/**
 * Password policy for staff accounts. Deliberately strict — these accounts can
 * approve loans, post journals and move money.
 */
export function validatePassword(password: string): { ok: true } | { ok: false; error: string } {
  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` };
  }
  if (password.length > 128) {
    return { ok: false, error: 'Password must be at most 128 characters.' };
  }
  if (!/[a-z]/.test(password)) {
    return { ok: false, error: 'Password must include a lowercase letter.' };
  }
  if (!/[A-Z]/.test(password)) {
    return { ok: false, error: 'Password must include an uppercase letter.' };
  }
  if (!/[0-9]/.test(password)) {
    return { ok: false, error: 'Password must include a number.' };
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    return { ok: false, error: 'Password must include a symbol.' };
  }
  if (COMMON_PASSWORDS.has(passwordStem(password))) {
    return {
      ok: false,
      error: 'That password is one of the most commonly used ones. Choose something else.',
    };
  }
  if (hasLongRun(password)) {
    return { ok: false, error: 'Password must not repeat the same character four times over.' };
  }
  if (hasSequence(password)) {
    return {
      ok: false,
      error: 'Password must not contain a keyboard or alphabet sequence such as "abcd" or "1234".',
    };
  }
  return { ok: true };
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Temporary password issued when an admin creates or resets an account.
 *
 * Every draw comes from the CSPRNG: `Math.random()` here would mean the whole
 * stream of issued credentials could be reconstructed from a couple of observed
 * samples, and these are handed out precisely to people who have not yet proved
 * anything. The candidate is then put through the same policy the account will
 * be held to, and resampled if it fails — patching a rejected candidate in
 * place would bias exactly the positions the policy looks at.
 */
export function generateTempPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%&*?';
  const all = upper + lower + digits + symbols;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const chars = [securePick(upper), securePick(lower), securePick(digits), securePick(symbols)];
    while (chars.length < 16) chars.push(securePick(all));

    const candidate = secureShuffle(chars).join('');
    if (validatePassword(candidate).ok) return candidate;
  }

  // 16 CSPRNG draws over that alphabet failing the policy 50 times running is
  // not something that happens; throwing beats returning a credential that
  // would be rejected the moment its owner tried to change it.
  throw new Error('Could not generate a temporary password that satisfies the password policy.');
}
