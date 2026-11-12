export const GENERATION_TIMEOUT_MS = 60_000;
export const GENERATION_TIMEOUT_MESSAGE =
  'Design generation timed out. Please try again with a simpler request.';

export function isGenerationTimeout(error: unknown): boolean {
  return error instanceof Error &&
    ['TimeoutError', 'APIConnectionTimeoutError'].includes(error.name);
}

export async function withGenerationTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(GENERATION_TIMEOUT_MESSAGE);
      error.name = 'TimeoutError';
      reject(error);
      controller.abort(error);
    }, GENERATION_TIMEOUT_MS);
  });

  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
