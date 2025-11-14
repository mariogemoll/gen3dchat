import { StateGraph, START, END, Annotation } from '@langchain/langgraph';
import { validateJscadCode } from './jscad-validator';
import { CloudflareKVSaver } from './kv';
import type { DbEnv } from './db';
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain';
import { Client } from 'langsmith';
import { incrementUsage } from './usage-tracker';

// Environment interface for agent needs
export interface AgentEnv extends DbEnv {
  HISTORY: any;
  JSCAD_VALIDATION_SERVICE_URL?: string;
  ANTHROPIC_API_KEY: string;
  LANGCHAIN_TRACING_V2?: string;
  LANGCHAIN_API_KEY?: string;
  LANGCHAIN_PROJECT?: string;
}

export interface ChangeHistoryItem {
  prompt: string;
  changeSummary: string;
  response: string;
}

interface UserUpdate {
  code: string;
  validationErrors?: string;
}

interface StagingIteration {
  updatedCode?: string;
  message: string;
  summary: string;
  validationErrors?: string;
}

interface Response {
  message: string;
  code?: string;
}

const StateAnnotation = Annotation.Root({
  changeHistory: Annotation<ChangeHistoryItem[]>({
    reducer: (current, update) => update ?? current,
    default: () => [],
  }),
  lastValidCode: Annotation<string>({
    reducer: (current, update) => update ?? current,
    default: () => '',
  }),
  userPrompt: Annotation<string | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),
  userUpdate: Annotation<UserUpdate | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),
  stagingIterations: Annotation<StagingIteration[]>({
    reducer: (current, update) => update ?? current,
    default: () => [],
  }),
  summary: Annotation<string | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  response: Annotation<Response | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),
});

type State = typeof StateAnnotation.State;

// Helper type to ensure at least one input is provided
type ValidStateInput = State & {
  // At least one of userPrompt or userUpdate must be defined
  userPrompt: string;
  userUpdate?: UserUpdate;
} | {
  userPrompt?: string;
  userUpdate: UserUpdate;
} | {
  userPrompt: string;
  userUpdate: UserUpdate;
};

// Validator interface for code validation
export interface CodeValidator {
  validate(code: string): Promise<string | undefined>;
}

// Default validator using jscad-validator
export class JscadValidator implements CodeValidator {
  constructor(private validationServiceUrl?: string) {}

  async validate(code: string): Promise<string | undefined> {
    const result = await validateJscadCode(code, this.validationServiceUrl);

    if (!result.ok) {
      // Format error message with phase if available
      const phasePrefix = result.phase ? `[${result.phase}] ` : '';
      return `${phasePrefix}${result.error || 'Validation failed'}`;
    }

    return undefined; // No errors
  }
}

// Factory function to create validateUserUpdate with injectable validator
function createValidateUserUpdate(validator: CodeValidator) {
  return async (state: State): Promise<State> => {
    // Runtime validation: ensure at least one input is provided
    if (!state.userPrompt && !state.userUpdate) {
      throw new Error('Either userPrompt or userUpdate must be provided');
    }

    // If there's a userUpdate with code, validate it
    if (state.userUpdate) {
      const validationError = await validator.validate(state.userUpdate.code);

      const updatedState = {
        ...state,
        userUpdate: {
          ...state.userUpdate,
          validationErrors: validationError,
        },
      };

      // If going directly to finalize (no prompt, valid code), set result and summary
      if (!state.userPrompt && !validationError) {
        return {
          ...updatedState,
          summary: 'Code updated by the user',
          response: {
            message: 'Code updated',
            code: state.userUpdate.code,
          },
        };
      }

      return updatedState;
    }

    return state;
  };
}

// Node to finalize the state after processing
function finalize(state: State): State {
  if (!state.response || !state.summary) {
    return state;
  }

  // Create new change history entry
  const newHistoryEntry: ChangeHistoryItem = {
    prompt: state.userPrompt || '',
    changeSummary: state.summary,
    response: state.response.message,
  };

  // Update lastValidCode if response has code
  const newLastValidCode = state.response.code || state.lastValidCode;

  // Return state with only response, changeHistory, and lastValidCode (clear summary)
  return {
    changeHistory: [...state.changeHistory, newHistoryEntry],
    lastValidCode: newLastValidCode,
    userPrompt: undefined,
    userUpdate: undefined,
    stagingIterations: [],
    summary: undefined,
    response: state.response,
  };
}

// Node for generating LLM response (may include code or just text)
async function generateResponse(state: State, config: { validator: CodeValidator; apiKey?: string; db?: any }): Promise<State> {
  // Import at runtime to avoid issues
  const { ChatAnthropic } = await import('@langchain/anthropic');
  const { HumanMessage } = await import('@langchain/core/messages');

  const apiKey = config.apiKey || '';

  const llm = new ChatAnthropic({
    model: 'claude-sonnet-4-5',
    apiKey,
  });

  // If there's no explicit prompt but there are validation errors, create a default prompt
  let userPrompt = state.userPrompt;
  if (!userPrompt && state.userUpdate?.validationErrors) {
    userPrompt = 'Please fix the validation errors in this code.';
  }
  if (!userPrompt) {
    userPrompt = '';
  }

  // Build all content blocks (can be empty strings)
  const baseInstructions = `You're an expert JSCAD (JavaScript CAD) agent that helps users create and modify 3D designs using code.

JSCAD is a library for creating 3D geometry using JavaScript. The main concepts:
- You write a function that returns 3D primitives or operations
- Common primitives: cube, sphere, cylinder, etc.
- Operations: union, subtract, intersect, translate, rotate, scale
- All functions are available from the jscadModeling global object

IMPORTANT - Face Ordering: When working with custom geometry or manipulating faces directly, ensure faces are ordered correctly:
- Faces must be ordered counter-clockwise when viewed from the outside (following the right-hand rule)
- Correct face ordering is critical for proper normals, rendering, and boolean operations
- The jscadModeling library handles face ordering automatically for primitives, but be aware of this when creating custom geometries or using advanced operations`;

  const lastValidCodeBlock = state.lastValidCode
    ? `Last valid code:
\`\`\`javascript
${state.lastValidCode}
\`\`\``
    : '';

  const userProvidedCodeBlock = state.userUpdate?.code
    ? `User-provided code update:
\`\`\`javascript
${state.userUpdate.code}
\`\`\``
    : '';

  const userCodeValidationErrorsBlock = state.userUpdate?.validationErrors
    ? `Validation errors for the user-provided code:
${state.userUpdate.validationErrors}`
    : '';

  const userPromptBlock = `The user provided the following prompt:
${userPrompt}`;

  const changeHistoryBlock = (state.changeHistory && state.changeHistory.length > 0)
    ? `Conversation history (previous successful changes):

${state.changeHistory.map((item, index) => {
  return `Change ${index + 1}:
User request: ${item.prompt || '(code update)'}
What was done: ${item.changeSummary}
Response: ${item.response}`;
}).join('\n\n')}`
    : '';

  const previousAttemptsBlock = (state.stagingIterations && state.stagingIterations.length > 0)
    ? `Previous attempts to solve this problem:

${state.stagingIterations.map((iteration, index) => {
  const status = iteration.validationErrors
    ? `Validation errors: ${iteration.validationErrors}`
    : `Status: Validation passed`;

  return `Attempt ${index + 1}:
Summary: ${iteration.summary}
${status}`;
}).join('\n\n')}`
    : '';

  const responseFormatInstructions = `Please provide:
1. MESSAGE: A user-friendly message (1-2 sentences) that will be shown to the user
2. SUMMARY: A technical summary (1-2 sentences) for your own reference in future attempts
3. CODE: The complete JSCAD code (optional - omit if you're just answering a question)

Format your response exactly like this:
MESSAGE: [User-friendly explanation here]
SUMMARY: [Technical summary for model's reference]
CODE:
\`\`\`javascript
[Your code here - optional]
\`\`\`

IMPORTANT: The code MUST follow this structure:
- Destructure the needed modules from jscadModeling at the top level
- Define a main() function that returns the geometry
- The main() function is the entry point and must return the final 3D geometry

Example response with code:
MESSAGE: I've created a simple cube positioned on the build plate, ready for 3D printing.
SUMMARY: Created 10mm cube using primitives.cube with center positioned at [0,0,5] to sit on XY plane.
CODE:
\`\`\`javascript
const { primitives } = jscadModeling

function main() {
  return primitives.cube({ size: 10, center: [0, 0, 5] })
}
\`\`\`

Example response without code (just answering):
MESSAGE: JSCAD uses the jscadModeling object to access primitives. You can create basic shapes like cube, sphere, and cylinder.
SUMMARY: Provided explanation of jscadModeling object structure and available primitives.

Make sure the code is valid JSCAD and follows these patterns:
- Use jscadModeling for accessing primitives and operations
- Always define a main() function that returns the final geometry
- Use proper syntax and avoid common errors

COMMON MISTAKES TO AVOID:
1. Missing main() function: The code MUST define a main() function - this is required and will cause validation to fail
2. Wrong return type: main() must return a JSCAD geometry object (with polygons property), NOT a string, number, or array of primitives. Use booleans.union() if you need to combine multiple primitives
3. Using import/require: NEVER use import or require statements. Always use the jscadModeling global object that's already available
4. Not destructuring: Always destructure needed modules from jscadModeling at the top level: const { primitives, transforms, booleans } = jscadModeling
5. Negative sizes: Avoid negative dimensions (e.g., size: -5) as they cause runtime errors. Use positive values and transforms for positioning
6. Forgetting to return: Always explicitly return the geometry from main() - don't just create it
7. Non-manifold geometry: Ensure all faces are properly connected to create watertight, solid objects. This is especially important for boolean operations and 3D printing
8. Incorrect module access: Access modules via jscadModeling (e.g., jscadModeling.primitives.cube), not as separate imports`;

  // Assemble the prompt in the correct order, filtering out empty blocks
  const systemPrompt = [
    baseInstructions,
    changeHistoryBlock,
    lastValidCodeBlock,
    userProvidedCodeBlock,
    userCodeValidationErrorsBlock,
    userPromptBlock,
    responseFormatInstructions,
    previousAttemptsBlock,
  ]
    .filter(block => block !== '')
    .join('\n\n');

  const userMessage = new HumanMessage(userPrompt);

  console.log('LLM System Prompt:', systemPrompt);
  console.log('LLM User Message:', userPrompt);

  const response = await llm.invoke([
    { role: 'system', content: systemPrompt },
    userMessage,
  ]);

  // Log full response object to see what metadata is available
  console.log('LLM Full Response:', JSON.stringify(response, null, 2));

  // Increment usage counter after successful LLM call
  if (config.db) {
    try {
      await incrementUsage(config.db);
    } catch (error) {
      console.error('Failed to increment usage counter:', error);
      // Don't fail the request if usage tracking fails
    }
  }

  const responseContent = typeof response.content === 'string' ? response.content : '';

  // Extract message, summary, and code from response
  const messageMatch = responseContent.match(/MESSAGE:\s*(.+?)(?=\n|SUMMARY:|CODE:|$)/s);
  const summaryMatch = responseContent.match(/SUMMARY:\s*(.+?)(?=\n|CODE:|$)/s);
  const codeBlockMatch = responseContent.match(/```(?:javascript|js|jscad)?\n([\s\S]*?)\n```/);

  const message = messageMatch ? messageMatch[1].trim() : 'LLM response';
  const summary = summaryMatch ? summaryMatch[1].trim() : message;

  if (codeBlockMatch) {
    const extractedCode = codeBlockMatch[1];

    // Create staging iteration WITHOUT validation (validation happens in separate node)
    const newIteration: StagingIteration = {
      updatedCode: extractedCode,
      message,
      summary,
      validationErrors: undefined, // Will be filled in by validation node
    };

    return {
      ...state,
      stagingIterations: [
        ...state.stagingIterations,
        newIteration,
      ],
    };
  }

  // No code block found - just a text response
  return {
    ...state,
    stagingIterations: [
      ...state.stagingIterations,
      {
        updatedCode: undefined,
        message,
        summary,
        validationErrors: undefined,
      },
    ],
  };
}

// Node to validate generated code
function createValidateGeneratedCode(validator: CodeValidator) {
  return async (state: State): Promise<State> => {
    // Get the last staging iteration (the one just created by generateResponse)
    const lastIteration = state.stagingIterations[state.stagingIterations.length - 1];

    if (!lastIteration) {
      return state;
    }

    // If there's no code in the last iteration, set result and summary
    if (!lastIteration.updatedCode) {
      return {
        ...state,
        summary: lastIteration.summary,
        response: {
          message: lastIteration.message,
        },
      };
    }

    // Validate the code
    const validationError = await validator.validate(lastIteration.updatedCode);

    // Update the last staging iteration with validation results
    const updatedIterations = [...state.stagingIterations];
    updatedIterations[updatedIterations.length - 1] = {
      ...lastIteration,
      validationErrors: validationError,
    };

    // Count failed iterations to check if we've hit the retry limit
    const failedIterations = updatedIterations.filter(it => it.validationErrors).length;

    if (!validationError) {
      // Code is valid - update lastValidCode and set result and summary
      return {
        ...state,
        lastValidCode: lastIteration.updatedCode!,
        stagingIterations: updatedIterations,
        summary: lastIteration.summary,
        response: {
          message: lastIteration.message,
          code: lastIteration.updatedCode,
        },
      };
    } else if (failedIterations >= 3) {
      // Failed after 3 attempts - set result and summary with failure message
      return {
        ...state,
        stagingIterations: updatedIterations,
        summary: 'Failed after 3 attempts',
        response: {
          message: "I can't help you with this request. Please try again with more details or a different approach.",
        },
      };
    } else {
      // Code has validation errors but we can retry
      return {
        ...state,
        stagingIterations: updatedIterations,
      };
    }
  };
}

// Routing function after validating generated code
function routeAfterGeneratedCodeValidation(state: State): string {
  const lastIteration = state.stagingIterations[state.stagingIterations.length - 1];

  // If validation succeeded, go to finalize
  if (lastIteration && !lastIteration.validationErrors) {
    return 'finalize';
  }

  // Count failed iterations (those with validation errors)
  const failedIterations = state.stagingIterations.filter(it => it.validationErrors).length;

  // If we've exceeded max retries (3), go to finalize
  if (failedIterations >= 3) {
    return 'finalize';
  }

  // Otherwise, retry generateResponse
  return 'generateResponse';
}

// Factory function to create generateResponse with injectable validator
function createGenerateResponse(validator: CodeValidator, apiKey?: string, db?: any) {
  return async (state: State): Promise<State> => {
    return generateResponse(state, { validator, apiKey, db });
  };
}

// Conditional routing after validation
function routeAfterValidation(state: State): string {
  // ONLY go to finalize if: validation passed AND no prompt
  // Everything else routes to generateResponse so LLM can help
  if (!state.userPrompt && state.userUpdate && !state.userUpdate.validationErrors) {
    return 'finalize';
  }

  // All other cases route to generateResponse:
  // - There's a prompt (with or without code, valid or invalid)
  // - There's validation errors (even without prompt - LLM can fix it)
  return 'generateResponse';
}

// Builder function to create the graph with injected dependencies
export function buildGraph(config: {
  validator: CodeValidator;
  checkpointer?: CloudflareKVSaver;
  apiKey?: string;
  db?: any;
}) {
  const graph = new StateGraph(StateAnnotation)
    .addNode('validateUserUpdate', createValidateUserUpdate(config.validator))
    .addNode('finalize', finalize)
    .addNode('generateResponse', createGenerateResponse(config.validator, config.apiKey, config.db))
    .addNode('validateGeneratedCode', createValidateGeneratedCode(config.validator))
    .addEdge(START, 'validateUserUpdate')
    .addConditionalEdges('validateUserUpdate', routeAfterValidation, {
      finalize: 'finalize',
      generateResponse: 'generateResponse',
    })
    .addEdge('finalize', END)
    .addEdge('generateResponse', 'validateGeneratedCode')
    .addConditionalEdges('validateGeneratedCode', routeAfterGeneratedCodeValidation, {
      generateResponse: 'generateResponse',
      finalize: 'finalize',
    });

  // Compile with checkpointer if provided, otherwise compile without persistence
  return config.checkpointer
    ? graph.compile({ checkpointer: config.checkpointer as any })
    : graph.compile();
}

// Initialize LangSmith tracer if enabled
export function createLangSmithCallbacks(env: AgentEnv): any[] {
  const langsmithClient = env.LANGCHAIN_TRACING_V2 === 'true' && env.LANGCHAIN_API_KEY
    ? new Client({
      apiKey: env.LANGCHAIN_API_KEY,
      apiUrl: 'https://eu.api.smith.langchain.com',
    })
    : undefined;

  return langsmithClient
    ? [new LangChainTracer({ projectName: env.LANGCHAIN_PROJECT || 'gen3dchat', client: langsmithClient })]
    : [];
}

// Flush LangSmith traces
export async function flushLangSmithTraces(env: AgentEnv): Promise<void> {
  if (env.LANGCHAIN_TRACING_V2 === 'true' && env.LANGCHAIN_API_KEY) {
    const client = new Client({
      apiKey: env.LANGCHAIN_API_KEY,
      apiUrl: 'https://eu.api.smith.langchain.com',
    });
    await client.awaitPendingTraceBatches?.();
  }
}

export type { State, ValidStateInput };