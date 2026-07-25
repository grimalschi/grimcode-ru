import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_SALT_LENGTH = 16;

export function newId(): string {
  return randomUUID();
}

/** URL-safe single-use token. Only its hash is ever stored. */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Password hash in the form `scrypt$<salt-hex>$<key-hex>`.
 *
 * Node's built-in scrypt keeps the template free of native build dependencies while staying a
 * memory-hard function; a concrete project may swap this for argon2 without touching callers.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_LENGTH);
  const key = await scryptAsync(password.normalize('NFKC'), salt, SCRYPT_KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;

  const expected = Buffer.from(keyHex, 'hex');
  if (expected.length !== SCRYPT_KEY_LENGTH) return false;

  const actual = await scryptAsync(
    password.normalize('NFKC'),
    Buffer.from(saltHex, 'hex'),
    SCRYPT_KEY_LENGTH,
  );
  return timingSafeEqual(actual, expected);
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
