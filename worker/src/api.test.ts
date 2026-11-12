import { describe, it, expect, vi, beforeEach } from 'vitest';
import app from './api';

const mockInvoke = vi.hoisted(() => vi.fn());
vi.mock('@langchain/openai', () => ({
  ChatOpenAI: vi.fn().mockImplementation(function () { return {
    invoke: mockInvoke,
  }; }),
}));

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
  ZAI_API_KEY: 'test-key-12345',
});

describe('API endpoints', () => {
  let mockEnv: any;

  beforeEach(() => {
    mockEnv = createMockEnv();
    mockInvoke.mockReset().mockRejectedValue(new Error('Mock LLM failure'));
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

    // Validation can fail without the service, and the model mock rejects any routed request.
    expect(json.threadId).toBeDefined();
  });

  it.each(['/_/threads', '/_/threads/existing'])('reports model timeouts for %s', async (path) => {
    const error = new Error('Request timed out');
    error.name = 'APIConnectionTimeoutError';
    mockInvoke.mockRejectedValue(error);
    mockEnv.DB.prepare().first.mockResolvedValue({ session_id: 'test-session', count: 0 });
    if (path.endsWith('/existing')) {
      mockEnv.HISTORY.get.mockResolvedValueOnce(JSON.stringify({ checkpoint: {} }));
    }
    const res = await app.fetch(new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'session_id=test-session' },
      body: JSON.stringify({ message: 'Please make a shelf', checkpointId: 'checkpoint' }),
    }), mockEnv);
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({
      error: 'Design generation timed out. Please try again with a simpler request.',
      threadId: expect.any(String),
    });
  });
});
