import { StateGraph, START, END, Annotation } from '@langchain/langgraph';
import { validateJscadCode } from './jscad-validator';
import { CloudflareKVSaver } from './kv';
import type { DbEnv } from './db';

// Environment interface for agent needs
export interface AgentEnv extends DbEnv {
  CHAT_HISTORY: any;
  JSCAD_VALIDATION_SERVICE_URL?: string;
  ANTHROPIC_API_KEY?: string;
}

interface ChangeHistoryItem {
  prompt: string;
  changeSummary: string;
  response: string;
}

interface UserUpdate {
  code: string;
  validationErrors?: string;
}

interface StagingIteration {
  updatedCode: string;
  comment: string;
  validationErrors?: string;
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

      return {
        ...state,
        userUpdate: {
          ...state.userUpdate,
          validationErrors: validationError,
        },
      };
    }

    return state;
  };
}

// Node to update lastValidCode when validation passes
function updateLastValidCode(state: State): State {
  if (state.userUpdate && !state.userUpdate.validationErrors) {
    return {
      ...state,
      lastValidCode: state.userUpdate.code,
    };
  }
  return state;
}

// Node for generating LLM response (may include code or just text)
async function generateResponse(state: State, config: { validator: CodeValidator; apiKey?: string }): Promise<State> {
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
- All functions are available from the jscadModeling global object`;

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

  const previousAttemptsBlock = (state.stagingIterations && state.stagingIterations.length > 0)
    ? `Previous attempts to solve this problem:

${state.stagingIterations.map((iteration, index) => {
  const status = iteration.validationErrors
    ? `Validation errors: ${iteration.validationErrors}`
    : `Status: Validation passed`;

  return `Attempt ${index + 1}:
Comment: ${iteration.comment}
${status}`;
}).join('\n\n')}`
    : '';

  const responseFormatInstructions = `Please provide:
1. A brief comment (1-2 sentences) explaining what change you made or what you created
2. The complete JSCAD code

Format your response exactly like this:
COMMENT: [Your brief explanation here]

CODE:
\`\`\`javascript
[Your code here]
\`\`\`

IMPORTANT: The code MUST follow this structure:
- Destructure the needed modules from jscadModeling at the top level
- Define a main() function that returns the geometry
- The main() function is the entry point and must return the final 3D geometry

Example response:
COMMENT: Created a simple cube positioned on the build plate.

CODE:
\`\`\`javascript
const { primitives } = jscadModeling

function main() {
  return primitives.cube({ size: 10, center: [0, 0, 5] })
}
\`\`\`

Make sure the code is valid JSCAD and follows these patterns:
- Use jscadModeling for accessing primitives and operations
- Always define a main() function that returns the final geometry
- Use proper syntax and avoid common errors`;

  // Assemble the prompt in the correct order, filtering out empty blocks
  const systemPrompt = [
    baseInstructions,
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

  const response = await llm.invoke([
    { role: 'system', content: systemPrompt },
    userMessage,
  ]);

  const responseContent = typeof response.content === 'string' ? response.content : '';

  // Extract comment and code from response
  const commentMatch = responseContent.match(/COMMENT:\s*(.+?)(?=\n|CODE:|$)/s);
  const codeBlockMatch = responseContent.match(/```(?:javascript|js|jscad)?\n([\s\S]*?)\n```/);

  const comment = commentMatch ? commentMatch[1].trim() : 'LLM response';

  if (codeBlockMatch) {
    const extractedCode = codeBlockMatch[1];

    // Create staging iteration WITHOUT validation (validation happens in separate node)
    const newIteration: StagingIteration = {
      updatedCode: extractedCode,
      comment,
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

  // No code block found - create a staging iteration with just the comment
  return {
    ...state,
    stagingIterations: [
      ...state.stagingIterations,
      {
        updatedCode: state.lastValidCode || '',
        comment: `No code generated: ${comment}`,
        validationErrors: 'No code block found in LLM response',
      },
    ],
  };
}

// Node to validate generated code
function createValidateGeneratedCode(validator: CodeValidator) {
  return async (state: State): Promise<State> => {
    // Get the last staging iteration (the one just created by generateCode)
    const lastIteration = state.stagingIterations[state.stagingIterations.length - 1];

    if (!lastIteration || !lastIteration.updatedCode) {
      // No code to validate
      return state;
    }

    // Validate the code
    const validationError = await validator.validate(lastIteration.updatedCode);

    // Update the last staging iteration with validation results
    const updatedIterations = [...state.stagingIterations];
    updatedIterations[updatedIterations.length - 1] = {
      ...lastIteration,
      validationErrors: validationError,
    };

    if (!validationError) {
      // Code is valid - update lastValidCode
      return {
        ...state,
        lastValidCode: lastIteration.updatedCode,
        stagingIterations: updatedIterations,
      };
    } else {
      // Code has validation errors
      return {
        ...state,
        stagingIterations: updatedIterations,
      };
    }
  };
}

// Placeholder node for summarization (TBD)
function summarize(state: State): State {
  // TODO: Implement summarization logic
  // This will create a summary of all staging iterations and provide feedback
  return state;
}

// Routing function after validating generated code
function routeAfterGeneratedCodeValidation(state: State): string {
  const lastIteration = state.stagingIterations[state.stagingIterations.length - 1];

  // If validation succeeded, go to summarization
  if (lastIteration && !lastIteration.validationErrors) {
    return 'summarize';
  }

  // Count failed iterations (those with validation errors)
  const failedIterations = state.stagingIterations.filter(it => it.validationErrors).length;

  // If we've exceeded max retries (3), go to summarization
  if (failedIterations >= 3) {
    return 'summarize';
  }

  // Otherwise, retry generateResponse
  return 'generateResponse';
}

// Factory function to create generateResponse with injectable validator
function createGenerateResponse(validator: CodeValidator, apiKey?: string) {
  return async (state: State): Promise<State> => {
    return generateResponse(state, { validator, apiKey });
  };
}

// Conditional routing after validation
function routeAfterValidation(state: State): string {
  // ONLY update lastValidCode if: validation passed AND no prompt
  // Everything else routes to generateCode so LLM can help
  if (!state.userPrompt && state.userUpdate && !state.userUpdate.validationErrors) {
    return 'updateLastValidCode';
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
}) {
  const graph = new StateGraph(StateAnnotation)
    .addNode('validateUserUpdate', createValidateUserUpdate(config.validator))
    .addNode('updateLastValidCode', updateLastValidCode)
    .addNode('generateResponse', createGenerateResponse(config.validator, config.apiKey))
    .addNode('validateGeneratedCode', createValidateGeneratedCode(config.validator))
    .addNode('summarize', summarize)
    .addEdge(START, 'validateUserUpdate')
    .addConditionalEdges('validateUserUpdate', routeAfterValidation, {
      updateLastValidCode: 'updateLastValidCode',
      generateResponse: 'generateResponse',
      [END]: END,
    })
    .addEdge('updateLastValidCode', END)
    .addEdge('generateResponse', 'validateGeneratedCode')
    .addConditionalEdges('validateGeneratedCode', routeAfterGeneratedCodeValidation, {
      generateResponse: 'generateResponse',
      summarize: 'summarize',
    })
    .addEdge('summarize', END);

  // Compile with checkpointer if provided, otherwise compile without persistence
  return config.checkpointer
    ? graph.compile({ checkpointer: config.checkpointer as any })
    : graph.compile();
}

export type { State, ValidStateInput };