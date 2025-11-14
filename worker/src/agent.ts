import { StateGraph, START, END, Annotation } from '@langchain/langgraph';
import { validateJscadCode } from './jscad-validator';

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
export function createValidateUserUpdate(validator: CodeValidator) {
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

// Builder function to create the graph with injected dependencies
export function buildGraph(config: { validator: CodeValidator }) {
  return new StateGraph(StateAnnotation)
    .addNode('validateUserUpdate', createValidateUserUpdate(config.validator))
    .addEdge(START, 'validateUserUpdate')
    .addEdge('validateUserUpdate', END)
    .compile();
}

export type { State, ValidStateInput };