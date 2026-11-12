import { expect, it, vi } from 'vitest';
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { CloudflareKVSaver } from './kv';

function createSaver() {
  const values = new Map<string, string>();
  const db = { prepare: vi.fn() };
  const kv = {
    async get(key: string) { return values.get(key) ?? null; },
    async put(key: string, value: string) { values.set(key, value); },
  };
  const saver = new CloudflareKVSaver(kv, db, {
    DB: db, SQIDS_THREAD_ALPHABET: 'abc', SQIDS_CHECKPOINT_ALPHABET: 'abc',
  });
  return { saver, values, db };
}

it('preserves cleared state and resolves exact checkpoint and parent IDs', async () => {
  const { saver, db } = createSaver();
  const root = emptyCheckpoint();
  root.id = 'root';
  root.channel_values = { summary: undefined, lastValidCode: 'cube' };
  const rootConfig = await saver.put({ configurable: { thread_id: 'thread' } }, root, {
    source: 'loop', step: 0, parents: {},
  });
  const child = emptyCheckpoint();
  child.id = 'child';
  await saver.put(rootConfig, child, { source: 'loop', step: 1, parents: {} });
  const restoredRoot = await saver.getTuple(rootConfig);
  expect(restoredRoot?.checkpoint.id).toBe('root');
  expect(restoredRoot?.checkpoint.channel_values).toHaveProperty('summary', undefined);
  const latest = await saver.getTuple({ configurable: { thread_id: 'thread' } });
  expect(latest?.checkpoint.id).toBe('child');
  expect(latest?.parentConfig?.configurable?.checkpoint_id).toBe('root');
  expect(db.prepare).not.toHaveBeenCalled();
});

it('loads existing JSON checkpoints without following invalid legacy parent pointers', async () => {
  const { saver, values } = createSaver();
  const checkpoint = emptyCheckpoint();
  const config = { configurable: { thread_id: 'thread' } };
  values.set('checkpoint:thread:latest', JSON.stringify({ config, checkpoint, parentConfig: config }));
  const restored = await saver.getTuple(config);
  expect(restored?.checkpoint.id).toBe(checkpoint.id);
  expect(restored?.config.configurable?.checkpoint_id).toBe(checkpoint.id);
  expect(restored?.parentConfig).toBeUndefined();
});
