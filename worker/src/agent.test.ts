import { describe, it, expect, vi } from 'vitest';
import { buildGraph, type CodeValidator } from './agent';
import { ChatOpenAI } from '@langchain/openai';

const mockInvoke = vi.hoisted(() => vi.fn().mockRejectedValue(new Error('Mock LLM failure')));
vi.mock('@langchain/openai', () => ({
  ChatOpenAI: vi.fn().mockImplementation(function () { return { invoke: mockInvoke }; }),
}));

// Mock validator for testing
class MockValidator implements CodeValidator {
  constructor(private errorMessage?: string) {}

  async validate(code: string): Promise<string | undefined> {
    return this.errorMessage;
  }
}

describe('agent graph', () => {
  it('should build graph without checkpointer', async () => {
    const graph = buildGraph({ validator: new MockValidator() });
    expect(graph).toBeDefined();
  });

  it('should build graph with checkpointer', async () => {
    const mockCheckpointer = {
      getTuple: vi.fn(),
      put: vi.fn(),
      list: vi.fn(),
    } as any;

    const graph = buildGraph({
      validator: new MockValidator(),
      checkpointer: mockCheckpointer
    });
    expect(graph).toBeDefined();
  });

  it('should throw error when neither userPrompt nor userUpdate is provided', async () => {
    const graph = buildGraph({ validator: new MockValidator() });
    const initialState = {
      changeHistory: [],
      lastValidCode: 'const x = 1;',
      userPrompt: undefined,
      userUpdate: undefined,
      stagingIterations: [],
    };

    await expect(graph.invoke(initialState)).rejects.toThrow(
      'Either userPrompt or userUpdate must be provided'
    );
  });

  it('should handle user prompt with generateResponse', async () => {
    const graph = buildGraph({ validator: new MockValidator(), apiKey: 'test-key' });
    const initialState = {
      changeHistory: [],
      lastValidCode: 'const x = 1;',
      userPrompt: 'Update variable name',
      userUpdate: undefined,
      stagingIterations: [],
    };

    // The mock confirms that the graph reaches the configured model client.
    await expect(graph.invoke(initialState)).rejects.toThrow('Mock LLM failure');
    expect(ChatOpenAI).toHaveBeenCalledWith({
      model: 'glm-5.3',
      apiKey: 'test-key',
      modelKwargs: { reasoning_effort: 'low' },
      maxTokens: 4096,
      timeout: 45_000,
      maxRetries: 0,
      configuration: { baseURL: 'https://api.z.ai/api/paas/v4/' },
    });
    expect(mockInvoke).toHaveBeenCalled();
  });

  it('forwards cancellation to the model request', async () => {
    const controller = new AbortController();
    const graph = buildGraph({ validator: new MockValidator(), apiKey: 'test-key' });
    await expect(graph.invoke({ userPrompt: 'Make a shelf' }, {
      signal: controller.signal,
    })).rejects.toThrow('Mock LLM failure');
    const signal = mockInvoke.mock.lastCall?.[1]?.signal as AbortSignal;
    expect(signal).toBeDefined();
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it('sends the reasoning effort and token budget to the provider', async () => {
    const graph = buildGraph({ validator: new MockValidator(), apiKey: 'test-key' });
    await expect(graph.invoke({ userPrompt: 'Make a shelf' })).rejects.toThrow('Mock LLM failure');
    const settings = vi.mocked(ChatOpenAI).mock.lastCall?.[0];
    expect(typeof settings).toBe('object');
    const { ChatOpenAI: RealChatOpenAI } = await vi.importActual<typeof import('@langchain/openai')>('@langchain/openai');
    const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.reasoning_effort).toBe('low');
      expect(body.max_tokens).toBe(4096);
      return Response.json({
        id: 'test', object: 'chat.completion', created: 0, model: 'glm-5.3',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Shelf' }, finish_reason: 'stop' }],
      });
    });
    if (typeof settings !== 'object') throw new Error('Missing model settings');
    const model = new RealChatOpenAI({
      ...settings,
      configuration: { baseURL: 'https://api.z.ai/api/paas/v4/', fetch },
    });
    await model.invoke('Make a shelf');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('discards truncated output and preserves the last valid design', async () => {
    mockInvoke.mockResolvedValueOnce({
      content: 'MESSAGE: Created a shelf\nCODE:\n```javascript\nfunction main() {',
      response_metadata: { finish_reason: 'length' },
    });
    const validator = { validate: vi.fn() };
    const graph = buildGraph({ validator, apiKey: 'test-key' });
    const result = await graph.invoke({ userPrompt: 'Make a shelf', lastValidCode: 'previous design' });
    expect(result.response?.message).toContain('generation limit');
    expect(result.lastValidCode).toBe('previous design');
    expect(validator.validate).not.toHaveBeenCalled();
  });

  it('should validate user update with valid code', async () => {
    const graph = buildGraph({ validator: new MockValidator() }); // No error
    const initialState = {
      changeHistory: [],
      lastValidCode: 'const x = 1;',
      userPrompt: undefined,
      userUpdate: {
        code: 'const y = 2;',
        validationErrors: undefined,
      },
      stagingIterations: [],
    };

    const result = await graph.invoke(initialState);

    expect(result.userUpdate).toBeDefined();
    expect(result.userUpdate?.code).toBe('const y = 2;');
    expect(result.userUpdate?.validationErrors).toBeUndefined();
  });

  it('should add validation errors for invalid code', async () => {
    const graph = buildGraph({ validator: new MockValidator('Syntax error: unexpected token'), apiKey: 'test-key' });
    const initialState = {
      changeHistory: [],
      lastValidCode: 'const x = 1;',
      userPrompt: undefined,
      userUpdate: {
        code: 'const y = ;',
        validationErrors: undefined,
      },
      stagingIterations: [],
    };

    // The model mock rejects after validation routes the update to generateResponse.
    await expect(graph.invoke(initialState)).rejects.toThrow();
  });

  it('should preserve change history and add new entry in finalize', async () => {
    const graph = buildGraph({ validator: new MockValidator() });
    const changeHistory = [
      {
        prompt: 'Add new function',
        changeSummary: 'Added calculateSum function',
        response: 'Function added successfully',
      },
    ];

    const initialState = {
      changeHistory,
      lastValidCode: 'const x = 1;',
      userPrompt: undefined,
      userUpdate: {
        code: 'const y = 2;',
      },
      stagingIterations: [],
    };

    const result = await graph.invoke(initialState);

    // Should have 2 entries: the original + the new one from finalize
    expect(result.changeHistory).toHaveLength(2);
    expect(result.changeHistory[0].prompt).toBe('Add new function');
    expect(result.changeHistory[0].changeSummary).toBe('Added calculateSum function');
    expect(result.changeHistory[1].prompt).toBe('');
    expect(result.changeHistory[1].changeSummary).toBe('Code updated by the user');
    expect(result.changeHistory[1].response).toBe('Code updated');
  });

  it('should clear staging iterations in finalize', async () => {
    const graph = buildGraph({ validator: new MockValidator() });
    const stagingIterations = [
      {
        updatedCode: 'const x = 1;',
        message: 'Created initial version',
        summary: 'Initial version with x=1',
        validationErrors: undefined,
      },
      {
        updatedCode: 'const x = 2;',
        message: 'Updated the value',
        summary: 'Changed x from 1 to 2',
        validationErrors: 'Type mismatch',
      },
    ];

    const initialState = {
      changeHistory: [],
      lastValidCode: 'const x = 1;',
      userPrompt: undefined,
      userUpdate: {
        code: 'const z = 3;',
      },
      stagingIterations,
    };

    const result = await graph.invoke(initialState);

    // Finalize clears staging iterations
    expect(result.stagingIterations).toHaveLength(0);
    // But preserves the result
    expect(result.response).toBeDefined();
  });

  it('should validate code and preserve existing validationErrors field if no error', async () => {
    const graph = buildGraph({ validator: new MockValidator() });
    const initialState = {
      changeHistory: [],
      lastValidCode: 'const x = 1;',
      userPrompt: undefined,
      userUpdate: {
        code: 'const y = 2;',
        validationErrors: 'Old error',
      },
      stagingIterations: [],
    };

    const result = await graph.invoke(initialState);

    // Validation should override the old error with undefined (no error found)
    expect(result.userUpdate?.validationErrors).toBeUndefined();
  });

  // Tests for conditional routing
  describe('conditional routing', () => {
    it('should update lastValidCode in finalize when validation passes and no prompt', async () => {
      const graph = buildGraph({ validator: new MockValidator() });
      const initialState = {
        changeHistory: [],
        lastValidCode: 'const x = 1;',
        userPrompt: undefined,
        userUpdate: {
          code: 'const y = 2;',
        },
        stagingIterations: [],
      };

      const result = await graph.invoke(initialState);

      expect(result.lastValidCode).toBe('const y = 2;');
      expect(result.userUpdate?.validationErrors).toBeUndefined();
      expect(result.response).toBeDefined();
      expect(result.response?.message).toBe('Code updated');
      expect(result.response?.code).toBe('const y = 2;');
      // Check that change history was updated
      expect(result.changeHistory).toHaveLength(1);
      expect(result.changeHistory[0].changeSummary).toBe('Code updated by the user');
      // Summary is cleared after being written to change history
      expect(result.summary).toBeUndefined();
    });

    it('should route to generateResponse when validation fails (to let LLM fix it)', async () => {
      const graph = buildGraph({ validator: new MockValidator('Syntax error'), apiKey: 'test-key' });
      const initialState = {
        changeHistory: [],
        lastValidCode: 'const x = 1;',
        userPrompt: undefined,
        userUpdate: {
          code: 'const y = ;',
        },
        stagingIterations: [],
      };

      // The model mock rejects after validation routes the update to generateResponse.
      await expect(graph.invoke(initialState)).rejects.toThrow();
    });

    it('should route to generateResponse when prompt exists', async () => {
      const graph = buildGraph({ validator: new MockValidator(), apiKey: 'test-key' });
      const initialState = {
        changeHistory: [],
        lastValidCode: 'const x = 1;',
        userPrompt: 'Make it better',
        userUpdate: undefined,
        stagingIterations: [],
      };

      // The model mock rejects once the prompt reaches generateResponse.
      await expect(graph.invoke(initialState)).rejects.toThrow();
    });

    it('should route to generateResponse even when valid update exists with prompt', async () => {
      const graph = buildGraph({ validator: new MockValidator(), apiKey: 'test-key' });
      const initialState = {
        changeHistory: [],
        lastValidCode: 'const x = 1;',
        userPrompt: 'Update this code',
        userUpdate: {
          code: 'const y = 2;',
        },
        stagingIterations: [],
      };

      // The model mock rejects once the prompt reaches generateResponse.
      await expect(graph.invoke(initialState)).rejects.toThrow();
    });
  });
});
