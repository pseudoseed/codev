import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as http from 'node:http';

const TEST_KEY = 'a'.repeat(64);

vi.mock('@cluesmith/codev-core/auth', () => ({
  ensureLocalKey: vi.fn(() => TEST_KEY),
  readLocalKey: vi.fn(() => TEST_KEY),
}));

import {
  isPublicRoute,
  isRequestAllowed,
  resetExpectedKeyCache,
} from '../utils/server-utils.js';
import { ensureLocalKey } from '@cluesmith/codev-core/auth';

function req(method: string, url: string, headers: Record<string, string> = {}): http.IncomingMessage {
  return { method, url, headers: { host: 'localhost:4100', ...headers } } as unknown as http.IncomingMessage;
}

beforeEach(() => {
  resetExpectedKeyCache();
  const mock = ensureLocalKey as unknown as ReturnType<typeof vi.fn>;
  mock.mockReset();
  mock.mockReturnValue(TEST_KEY);
});

describe('v2 public vs keyed (scenario 16)', () => {
  it('isPublicRoute: GET /v2/ and GET /v2/assets/* only', () => {
    expect(isPublicRoute('GET', '/v2/')).toBe(true);
    expect(isPublicRoute('GET', '/v2/assets/index.js')).toBe(true);
    expect(isPublicRoute('GET', '/v2/assets/app.css')).toBe(true);

    expect(isPublicRoute('GET', '/v2')).toBe(false);
    expect(isPublicRoute('GET', '/v2/events')).toBe(false);
    expect(isPublicRoute('GET', '/v2/events')).toBe(false);
    expect(isPublicRoute('POST', '/v2/')).toBe(false);
    expect(isPublicRoute('POST', '/v2/assets/index.js')).toBe(false);
    expect(isPublicRoute('GET', '/v2/nonsense')).toBe(false);
  });

  it('isRequestAllowed: keyless GET /v2/ and assets succeed', () => {
    expect(isRequestAllowed(req('GET', '/v2/'))).toBe(true);
    expect(isRequestAllowed(req('GET', '/v2/assets/index.js'))).toBe(true);
  });

  it('isRequestAllowed: keyless GET /v2/events is rejected', () => {
    expect(isRequestAllowed(req('GET', '/v2/events?scope=%2Ftmp'))).toBe(false);
  });

  it('isRequestAllowed: keyless POST /v2/ is rejected', () => {
    expect(isRequestAllowed(req('POST', '/v2/'))).toBe(false);
  });

  it('isRequestAllowed: keyed GET /v2/events is allowed', () => {
    expect(isRequestAllowed(req('GET', '/v2/events?scope=%2Ftmp', { 'codev-tower-key': TEST_KEY }))).toBe(true);
  });
});
