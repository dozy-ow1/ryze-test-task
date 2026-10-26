import { randomBytes } from 'node:crypto';
import { decryptToken, encryptToken } from '@ryze/shared';
import { describe, expect, it } from 'vitest';

const key = randomBytes(32).toString('base64');

describe('site token encryption', () => {
  it('round-trips and never stores the plaintext', () => {
    const blob = encryptToken('shpat_secret-token', key);
    expect(blob.includes(Buffer.from('shpat_secret-token'))).toBe(false);
    expect(decryptToken(blob, key)).toBe('shpat_secret-token');
  });

  it('uses a fresh IV every time', () => {
    expect(encryptToken('same', key).equals(encryptToken('same', key))).toBe(false);
  });

  it('rejects a tampered blob and a wrong key', () => {
    const blob = encryptToken('token', key);
    blob[blob.length - 1] ^= 1;
    expect(() => decryptToken(blob, key)).toThrow();
    const other = randomBytes(32).toString('base64');
    expect(() => decryptToken(encryptToken('token', key), other)).toThrow();
  });
});
