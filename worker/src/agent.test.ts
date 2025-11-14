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

  it('should handle user prompt without validation', async () => {
    const graph = buildGraph({ validator: new MockValidator() });
    const initialState = {
      changeHistory: [],
      lastValidCode: 'const x = 1;',
      userPrompt: 'Update variable name',
      userUpdate: undefined,
      stagingIterations: [],
    };

    const result = await graph.invoke(initialState);

    expect(result.userPrompt).toBe('Update variable name');
    expect(result.userUpdate).toBeUndefined();
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

  it('should preserve change history', async () => {
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
      userPrompt: 'Another change',
      userUpdate: undefined,
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
      userPrompt: 'Update again',
      userUpdate: undefined,
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
});
