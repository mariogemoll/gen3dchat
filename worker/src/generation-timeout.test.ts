import { afterEach, describe, expect, it, vi } from 'vitest';
import { GENERATION_TIMEOUT_MS, withGenerationTimeout } from './generation-timeout';

afterEach(() => vi.useRealTimers());

describe('generation deadline', () => {
  it('aborts and rejects even if the operation ignores cancellation', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const result = withGenerationTimeout((requestSignal) => {
      signal = requestSignal;
      return new Promise<never>(() => {});
    });
    const rejection = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(GENERATION_TIMEOUT_MS);
    await rejection;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the deadline after success or failure', async () => {
    vi.useFakeTimers();
    await expect(withGenerationTimeout(async () => 'cube')).resolves.toBe('cube');
    expect(vi.getTimerCount()).toBe(0);
    await expect(withGenerationTimeout(async () => {
      throw new Error('provider unavailable');
    })).rejects.toThrow('provider unavailable');
    expect(vi.getTimerCount()).toBe(0);
  });
});
