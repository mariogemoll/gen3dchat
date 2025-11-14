import { describe, it, expect, vi, beforeEach } from 'vitest';
import app from './api';

// Mock environment
const createMockEnv = (): any => ({
  CHAT_HISTORY: {
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
});

describe('API endpoints', () => {
  let mockEnv: any;

  beforeEach(() => {
    mockEnv = createMockEnv();
  });

  it('should require message in POST /_/threads', async () => {
    const req = new Request('http://localhost/_/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await app.fetch(req, mockEnv);
    const json = await res.json() as any;

    expect(res.status).toBe(400);
    expect(json.error).toBeDefined();
    expect(json.error.issues).toBeDefined();
    expect(json.error.issues[0].path[0]).toBe('message');
  });

  it('should reject prompts with 501 (not implemented)', async () => {
    const req = new Request('http://localhost/_/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Make me a cube' }),
    });
    const res = await app.fetch(req, mockEnv);
    const json = await res.json() as any;

    expect(res.status).toBe(501);
    expect(json.error).toContain('not yet implemented');
  });

  it('should handle valid code updates', async () => {
    const req = new Request('http://localhost/_/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '```javascript\nconst cube = () => { return []; }\n```'
      }),
    });

    const res = await app.fetch(req, mockEnv);
    const json = await res.json() as any;

    expect(res.status).toBe(200);
    expect(json.threadId).toBeDefined();
    expect(json.checkpointId).toBeDefined();
  });
});
