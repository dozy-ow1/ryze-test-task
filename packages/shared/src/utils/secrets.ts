import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Site tokens at rest: AES-256-GCM with SITE_TOKEN_KEY (32 bytes, base64), stored as
// iv(12) || auth tag(16) || ciphertext.

export function encryptToken(token: string, keyBase64: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv);
  const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);

  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function decryptToken(blob: Buffer, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(12, 28));

  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString('utf8');
}
