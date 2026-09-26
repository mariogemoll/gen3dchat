// Entry point for LangGraph Studio
import { buildGraph, JscadValidator } from './agent';

// Create validator instance
const validator = new JscadValidator(process.env.JSCAD_VALIDATION_SERVICE_URL);

// Export the compiled graph for Studio
export const graph = buildGraph({
  validator,
  apiKey: process.env.ZAI_API_KEY,
});
