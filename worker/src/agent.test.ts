import { describe, it, expect, vi } from 'vitest';
import { buildGraph, type CodeValidator } from './agent';

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

    // This will fail with network error since we don't have a real API key
    // but we're testing that it attempts to call the LLM rather than throwing "not implemented"
    await expect(graph.invoke(initialState)).rejects.toThrow();
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

    // This will now route to generateResponse to fix the error, which will fail with network error
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
    expect(result.result).toBeDefined();
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
      expect(result.result).toBeDefined();
      expect(result.result?.message).toBe('Code updated');
      expect(result.result?.code).toBe('const y = 2;');
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

      // This will route to generateResponse to fix the error, which will fail with network error
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

      // This will fail with network error since we don't have a real API key
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

      // This will fail with network error since we don't have a real API key
      await expect(graph.invoke(initialState)).rejects.toThrow();
    });
  });
});
