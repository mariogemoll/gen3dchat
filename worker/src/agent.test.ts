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

  it('should handle user prompt and throw on proposeChange', async () => {
    const graph = buildGraph({ validator: new MockValidator() });
    const initialState = {
      changeHistory: [],
      lastValidCode: 'const x = 1;',
      userPrompt: 'Update variable name',
      userUpdate: undefined,
      stagingIterations: [],
    };

    await expect(graph.invoke(initialState)).rejects.toThrow(
      'proposeChange not yet implemented'
    );
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
    const graph = buildGraph({ validator: new MockValidator('Syntax error: unexpected token') });
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

    const result = await graph.invoke(initialState);

    expect(result.userUpdate?.code).toBe('const y = ;');
    expect(result.userUpdate?.validationErrors).toBe('Syntax error: unexpected token');
  });

  it('should preserve change history in state', async () => {
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

    expect(result.changeHistory).toHaveLength(1);
    expect(result.changeHistory[0].prompt).toBe('Add new function');
    expect(result.changeHistory[0].changeSummary).toBe('Added calculateSum function');
  });

  it('should preserve staging iterations', async () => {
    const graph = buildGraph({ validator: new MockValidator() });
    const stagingIterations = [
      {
        updatedCode: 'const x = 1;',
        comment: 'Initial version',
        validationErrors: undefined,
      },
      {
        updatedCode: 'const x = 2;',
        comment: 'Updated value',
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

    expect(result.stagingIterations).toHaveLength(2);
    expect(result.stagingIterations[1].validationErrors).toBe('Type mismatch');
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
    it('should update lastValidCode and exit when validation passes and no prompt', async () => {
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
    });

    it('should exit immediately when validation fails', async () => {
      const graph = buildGraph({ validator: new MockValidator('Syntax error') });
      const initialState = {
        changeHistory: [],
        lastValidCode: 'const x = 1;',
        userPrompt: undefined,
        userUpdate: {
          code: 'const y = ;',
        },
        stagingIterations: [],
      };

      const result = await graph.invoke(initialState);

      expect(result.lastValidCode).toBe('const x = 1;'); // Should NOT update
      expect(result.userUpdate?.validationErrors).toBe('Syntax error');
    });

    it('should route to proposeChange when prompt exists and throw error', async () => {
      const graph = buildGraph({ validator: new MockValidator() });
      const initialState = {
        changeHistory: [],
        lastValidCode: 'const x = 1;',
        userPrompt: 'Make it better',
        userUpdate: undefined,
        stagingIterations: [],
      };

      await expect(graph.invoke(initialState)).rejects.toThrow(
        'proposeChange not yet implemented'
      );
    });

    it('should route to proposeChange even when valid update exists with prompt', async () => {
      const graph = buildGraph({ validator: new MockValidator() });
      const initialState = {
        changeHistory: [],
        lastValidCode: 'const x = 1;',
        userPrompt: 'Update this code',
        userUpdate: {
          code: 'const y = 2;',
        },
        stagingIterations: [],
      };

      await expect(graph.invoke(initialState)).rejects.toThrow(
        'proposeChange not yet implemented'
      );
    });
  });
});
