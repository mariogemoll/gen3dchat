// Validation API endpoint for Vercel Functions
import * as acorn from 'acorn'
import * as walk from 'acorn-walk'
import jscad from '@jscad/modeling'
import vm from 'vm'

const { primitives, booleans, transforms, colors, hulls, extrusions } = jscad

/**
 * Static AST validation to block dangerous operations
 */
function validateAst(code) {
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' })

  walk.simple(ast, {
    ImportDeclaration() {
      throw new Error('ES modules (import statements) are not allowed')
    },
    ImportExpression() {
      throw new Error('Dynamic import() is not allowed')
    },
    CallExpression(node) {
      const callee = node.callee

      if (callee?.type === 'Identifier' && callee.name === 'eval') {
        throw new Error('eval() is not allowed')
      }

      if (callee?.type === 'Identifier' && callee.name === 'require') {
        throw new Error('require() is not allowed')
      }
    },
    NewExpression(node) {
      const name = node.callee?.name

      if (name === 'Function') {
        throw new Error('Function constructor is not allowed')
      }

      if (name === 'WebAssembly') {
        throw new Error('WebAssembly is not allowed')
      }
    },
    MemberExpression(node) {
      if (node.object?.type === 'Identifier') {
        const objName = node.object.name
        const propName = node.property?.name || node.property?.value

        const dangerousGlobals = [
          'process', 'global', 'globalThis', 'self', 'window',
          '__proto__', 'prototype'
        ]

        if (dangerousGlobals.includes(objName)) {
          throw new Error(`Access to '${objName}' is not allowed`)
        }

        if (propName === 'constructor') {
          throw new Error('Access to constructor property is not allowed')
        }
      }
    }
  })
}

/**
 * Execute JSCAD code in isolated VM context with real JSCAD library
 */
function executeJscadInSandbox(code) {
  // Create sandbox context with JSCAD API
  const sandbox = {
    // Expose entire JSCAD modeling module
    jscadModeling: jscad,

    // Provide safe built-ins
    Array: Array,
    Object: Object,
    Math: Math,
    console: {
      log: () => {}, // Disable console.log
      error: () => {},
      warn: () => {},
    },
  }

  // Wrap user code to call main() and return result
  const wrappedCode = `
${code}

if (typeof main !== 'function') {
  throw new Error('Code must define a main() function');
}

main();
`

  // Execute in isolated context with timeout
  return vm.runInNewContext(wrappedCode, sandbox, {
    timeout: 5000, // 5 second timeout
    displayErrors: true,
  })
}

/**
 * Validate JSCAD code
 */
async function validateJscadCode(code) {
  // 1) AST validation first - blocks all dangerous operations
  try {
    validateAst(code)
  } catch (e) {
    return {
      ok: false,
      phase: 'validate',
      error: e.message
    }
  }

  // 2) Execute with real JSCAD in sandboxed VM
  try {
    const geometry = executeJscadInSandbox(code)

    // Validate the returned geometry
    const isValidGeometry =
      geometry &&
      typeof geometry === 'object' &&
      geometry.polygons &&
      Array.isArray(geometry.polygons)

    if (!isValidGeometry) {
      return {
        ok: false,
        phase: 'execute',
        error: `main() must return a JSCAD geometry object with polygons, got: ${typeof geometry}`
      }
    }

    return {
      ok: true,
      geometry: geometry
    }
  } catch (e) {
    return {
      ok: false,
      phase: 'execute',
      error: e.message || String(e)
    }
  }
}

/**
 * Vercel Function handler
 */
export { validateJscadCode }

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const { code } = req.body

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid code parameter' })
    }

    const result = await validateJscadCode(code)
    return res.status(200).json(result)
  } catch (e) {
    console.error('Validation error:', e)
    return res.status(500).json({
      ok: false,
      phase: 'server',
      error: e.message || 'Internal server error'
    })
  }
}
