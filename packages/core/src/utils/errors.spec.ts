import { describe, expect, it } from 'vitest';
import { classify, Deferred, isAuthError, Permanent } from './errors.js';
import { HttpError } from './http.js';

describe('classify', () => {
  it('maps every error onto deferred, transient or permanent', () => {
    expect(classify(new Deferred(new Date(), 'quota'))).toBe('deferred');
    expect(classify(new Permanent('bad'))).toBe('permanent');

    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(classify(new HttpError(status, 'x'))).toBe('permanent');
    }

    for (const status of [0, 429, 500, 502, 503, 529]) {
      expect(classify(new HttpError(status, 'x'))).toBe('transient');
    }

    expect(classify(new TypeError('surprise'))).toBe('transient');
    expect(isAuthError(new HttpError(401, 'x'))).toBe(true);
    expect(isAuthError(new HttpError(404, 'x'))).toBe(false);
  });
});
