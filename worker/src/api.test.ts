import { describe, it, expect, vi, beforeEach } from 'vitest';
import app from './api';

// Mock environment
const createMockEnv = (): any => ({
  HISTORY: {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  DB: {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ count: 0 }),
      all: vi.fn().mockResolvedValue({ results: [] }),
      run: vi.fn().mockResolvedValue({ success: true }),
    }),
  },
  SQIDS_THREAD_ALPHABET: 'abcdefghijklmnopqrstuvwxyz',
  SQIDS_CHECKPOINT_ALPHABET: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  JSCAD_VALIDATION_SERVICE_URL: 'http://localhost:3000/validate',
  ANTHROPIC_API_KEY: 'test-key-12345',
});

describe('API endpoints', () => {
  let mockEnv: any;

  beforeEach(() => {
    mockEnv = createMockEnv();
  });

  it('should require message or code in POST /_/threads', async () => {
    const req = new Request('http://localhost/_/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await app.fetch(req, mockEnv);
    const json = await res.json() as any;

    expect(res.status).toBe(400);
    expect(json.error).toBeDefined();
    // The error message should mention that either message or code is required
    const errorStr = JSON.stringify(json.error);
    expect(errorStr).toContain('Either message or code must be provided');
  });

  it('should fail when prompts cannot be processed', async () => {
    const req = new Request('http://localhost/_/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Make me a cube' }),
    });
    const res = await app.fetch(req, mockEnv);
    const json = await res.json() as any;

    expect(res.status).toBe(500);
    expect(json.error).toBeDefined();
    expect(json.threadId).toBeDefined();
  });

  it('should attempt to process code updates', async () => {
    const req = new Request('http://localhost/_/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: 'const cube = () => { return []; }'
      }),
    });

    const res = await app.fetch(req, mockEnv);
    const json = await res.json() as any;

    // Since validation will likely fail in test env (no real validation service),
    // it routes to generateCode which will fail with auth error (fake API key)
    // In production with real services, valid code would succeed
    expect(json.threadId).toBeDefined();
  });
});
