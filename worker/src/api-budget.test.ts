import { expect, it, vi } from 'vitest';
import app from './api';

const { invoke, validate } = vi.hoisted(() => ({ invoke: vi.fn(), validate: vi.fn() }));
vi.mock('@langchain/openai', () => ({
  ChatOpenAI: vi.fn().mockImplementation(function () { return { invoke }; }),
}));
vi.mock('./jscad-validator', () => ({ validateJscadCode: validate }));

it('creates and edits persisted designs within the 50-subrequest budget', async () => {
  let storageCalls = 0;
  const consumeStorage = () => {
    storageCalls++;
    if (storageCalls > 50) throw new Error('Storage subrequest budget exceeded');
  };
  const counters = new Map<string, number>();
  const ids = new Map<string, string>();
  const threads = new Map<string, string>();
  const kv = new Map<string, string>();
  const env = {
    DAILY_LLM_CALL_LIMIT: '1000', ZAI_API_KEY: 'test-key',
    SQIDS_THREAD_ALPHABET: 'abcdefghijklmnopqrstuvwxyz',
    SQIDS_CHECKPOINT_ALPHABET: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    JSCAD_VALIDATION_SERVICE_URL: 'https://validation.example/validate',
    DB: {
      prepare(sql: string) {
        let params: unknown[] = [];
        const statement = {
          bind(...values: unknown[]) { params = values; return statement; },
          async first() {
            consumeStorage();
            const key = String(params[0]);
            if (sql.startsWith('UPDATE counters')) {
              const value = (counters.get(key) ?? 0) + 1;
              counters.set(key, value);
              return { value };
            }
            if (sql.startsWith('SELECT session_id')) return { session_id: threads.get(key) };
            if (sql.startsWith('SELECT uuid')) return { uuid: ids.get(key) };
            if (sql.startsWith('SELECT sqid')) return { sqid: [...ids].find(([, uuid]) => uuid === key)?.[0] };
            return null;
          },
          async run() {
            consumeStorage();
            if (sql.startsWith('INSERT INTO threads')) threads.set(String(params[0]), String(params[1]));
            if (sql.startsWith('INSERT OR IGNORE INTO checkpoint_ids')) ids.set(String(params[0]), String(params[1]));
            return { success: true };
          },
        };
        return statement;
      },
    },
    HISTORY: {
      async get(key: string) { consumeStorage(); return kv.get(key) ?? null; },
      async put(key: string, value: string) { consumeStorage(); kv.set(key, value); },
    },
  };
  const code = 'const { primitives } = jscadModeling; function main() { return primitives.cuboid({size:[100,30,3]}); }';
  invoke.mockResolvedValue({ content: `MESSAGE: Shelf\nSUMMARY: Board\nCODE:\n\`\`\`javascript\n${code}\n\`\`\``, response_metadata: {} });
  validate.mockResolvedValue({ ok: true });
  const send = (path: string, body: Record<string, string>) => app.fetch(new Request(`https://example.com${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'session_id=test-session' },
    body: JSON.stringify(body),
  }), env);

  const created = await send('/_/threads', { message: 'Please make a shelf' });
  const design = await created.json() as { threadId: string; checkpointId: string; code: string };
  expect(created.status).toBe(200);
  expect(design.code).toBe(code);
  expect(ids.size).toBe(1);
  expect(storageCalls + invoke.mock.calls.length + validate.mock.calls.length).toBeLessThanOrEqual(50);

  storageCalls = 0;
  invoke.mockClear();
  validate.mockClear();
  // Exercise the full repair budget on a persisted conversation.
  validate.mockResolvedValueOnce({ ok: false, phase: 'execute', error: 'Invalid board size' });
  validate.mockResolvedValueOnce({ ok: false, phase: 'execute', error: 'Invalid board size' });
  const continued = await send(`/_/threads/${design.threadId}`, {
    message: 'Make the shelf wider', checkpointId: design.checkpointId,
  });
  const edit = await continued.json() as { code: string; checkpointId: string };
  expect(continued.status).toBe(200);
  expect(edit.code).toBe(code);
  expect(edit.checkpointId).not.toBe(design.checkpointId);
  expect(ids.size).toBe(2);
  expect(invoke).toHaveBeenCalledTimes(3);
  const saved = JSON.parse(kv.get(`checkpoint:${design.threadId}:latest`)!);
  expect(saved.checkpoint.channel_values.changeHistory).toHaveLength(2);
  expect(storageCalls + invoke.mock.calls.length + validate.mock.calls.length).toBeLessThanOrEqual(50);
});
