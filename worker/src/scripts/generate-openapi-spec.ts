#!/usr/bin/env tsx
/**
 * Generate OpenAPI spec from the API definition
 * This script exports the OpenAPI spec to a JSON file that can be committed to the repo
 */

import app from '../api.js';
import { writeFileSync } from 'fs';
import { join } from 'path';

// Get the OpenAPI spec from the app
const spec = app.getOpenAPIDocument({
  openapi: '3.1.0',
  info: {
    version: '1.0.0',
    title: 'Gen3D Chat API',
    description: 'API for creating and managing 3D design threads with JSCAD code generation',
  },
  tags: [
    {
      name: 'Threads',
      description: 'Thread management endpoints',
    },
  ],
});

// Write to file
const outputPath = join(__dirname, '../../../frontend/openapi.json');
writeFileSync(outputPath, JSON.stringify(spec, null, 2), 'utf-8');

console.log(`OpenAPI spec written to ${outputPath}`);
