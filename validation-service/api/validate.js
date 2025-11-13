// Validation API endpoint for Vercel Functions
import { getQuickJS } from 'quickjs-emscripten'
import * as acorn from 'acorn'
import * as walk from 'acorn-walk'

// Cache QuickJS module across invocations
let cachedQuickJS = null

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
 * JSCAD primitives available to user code
 */
const JSCAD_PRIMITIVES = `
// Basic 3D primitives
function cube(options) {
  if (typeof options === 'number') {
    return { type: 'geom3', primitiveType: 'cube', size: [options, options, options] };
  }
  return {
    type: 'geom3',
    primitiveType: 'cube',
    size: options?.size || [1, 1, 1],
    center: options?.center
  };
}

function sphere(options) {
  return {
    type: 'geom3',
    primitiveType: 'sphere',
    radius: options?.radius || 1,
    segments: options?.segments || 32,
    center: options?.center
  };
}

function cylinder(options) {
  return {
    type: 'geom3',
    primitiveType: 'cylinder',
    radius: options?.radius || 1,
    height: options?.height || 1,
    center: options?.center
  };
}

function cuboid(options) {
  return {
    type: 'geom3',
    primitiveType: 'cuboid',
    size: options?.size || [1, 1, 1],
    center: options?.center
  };
}

function roundedCuboid(options) {
  return {
    type: 'geom3',
    primitiveType: 'roundedCuboid',
    size: options?.size || [1, 1, 1],
    roundRadius: options?.roundRadius || 0.2,
    center: options?.center
  };
}

function cylinderElliptic(options) {
  return {
    type: 'geom3',
    primitiveType: 'cylinderElliptic',
    height: options?.height || 1,
    startRadius: options?.startRadius || [1, 1],
    endRadius: options?.endRadius || [1, 1],
    center: options?.center
  };
}

function ellipsoid(options) {
  return {
    type: 'geom3',
    primitiveType: 'ellipsoid',
    radius: options?.radius || [1, 1, 1],
    center: options?.center
  };
}

function geodesicSphere(options) {
  return {
    type: 'geom3',
    primitiveType: 'geodesicSphere',
    radius: options?.radius || 1,
    frequency: options?.frequency || 6
  };
}

function torus(options) {
  return {
    type: 'geom3',
    primitiveType: 'torus',
    innerRadius: options?.innerRadius || 0.5,
    outerRadius: options?.outerRadius || 1,
    innerSegments: options?.innerSegments || 32,
    outerSegments: options?.outerSegments || 32
  };
}

// Boolean operations
function union(...geometries) {
  return { type: 'geom3', operation: 'union', geometries: geometries.flat() };
}

function subtract(...geometries) {
  return { type: 'geom3', operation: 'subtract', geometries: geometries.flat() };
}

function intersect(...geometries) {
  return { type: 'geom3', operation: 'intersect', geometries: geometries.flat() };
}

// Transformations
function translate(offset, ...geometries) {
  return { type: 'geom3', operation: 'translate', offset, geometries: geometries.flat() };
}

function rotate(angles, ...geometries) {
  return { type: 'geom3', operation: 'rotate', angles, geometries: geometries.flat() };
}

function scale(factors, ...geometries) {
  return { type: 'geom3', operation: 'scale', factors, geometries: geometries.flat() };
}

function center(options, ...geometries) {
  return { type: 'geom3', operation: 'center', options, geometries: geometries.flat() };
}

function mirror(options, ...geometries) {
  return { type: 'geom3', operation: 'mirror', options, geometries: geometries.flat() };
}

// Color
function colorize(color, ...geometries) {
  return { type: 'geom3', operation: 'colorize', color, geometries: geometries.flat() };
}

// Hulls
function hull(...geometries) {
  return { type: 'geom3', operation: 'hull', geometries: geometries.flat() };
}

function hullChain(...geometries) {
  return { type: 'geom3', operation: 'hullChain', geometries: geometries.flat() };
}

// Extrusions
function extrudeLinear(options, geometry) {
  return { type: 'geom3', operation: 'extrudeLinear', options, geometry };
}

function extrudeRotate(options, geometry) {
  return { type: 'geom3', operation: 'extrudeRotate', options, geometry };
}

// 2D Primitives
function circle(options) {
  return { type: 'geom2', primitiveType: 'circle', radius: options?.radius || 1 };
}

function square(options) {
  return { type: 'geom2', primitiveType: 'square', size: options?.size || [1, 1] };
}

function rectangle(options) {
  return { type: 'geom2', primitiveType: 'rectangle', size: options?.size || [1, 1] };
}

function roundedRectangle(options) {
  return { type: 'geom2', primitiveType: 'roundedRectangle', size: options?.size || [1, 1], roundRadius: options?.roundRadius || 0.2 };
}

function polygon(options) {
  return { type: 'geom2', primitiveType: 'polygon', points: options?.points || [] };
}
`

/**
 * Validate JSCAD code in QuickJS sandbox
 */
async function validateJscadCode(code) {
  // 1) AST validation first
  try {
    validateAst(code)
  } catch (e) {
    return {
      ok: false,
      phase: 'validate',
      error: e.message
    }
  }

  // 2) Execute in QuickJS VM
  try {
    if (!cachedQuickJS) {
      cachedQuickJS = await getQuickJS()
    }

    const vm = cachedQuickJS.newContext()

    // Set limits
    try {
      if (vm.runtime?.setMemoryLimit) {
        vm.runtime.setMemoryLimit(50 * 1024 * 1024) // 50MB
      }
      if (vm.runtime?.setMaxStackSize) {
        vm.runtime.setMaxStackSize(5 * 1024 * 1024) // 5MB
      }
    } catch (e) {
      console.warn('Could not set QuickJS limits:', e)
    }

    const fullCode = `
${JSCAD_PRIMITIVES}

// User code
${code}

// Execute
if (typeof main !== 'function') {
  throw new Error('Code must define a main() function');
}
main();
`

    const result = vm.evalCode(fullCode)

    if (result.error) {
      const errorValue = vm.dump(result.error)
      vm.unwrapResult(result).dispose()
      vm.dispose()
      return {
        ok: false,
        phase: 'execute',
        error: String(errorValue)
      }
    }

    const value = vm.dump(result.value)
    vm.unwrapResult(result).dispose()
    vm.dispose()

    const isValidGeometry =
      value &&
      typeof value === 'object' &&
      (value.type === 'geom2' || value.type === 'geom3')

    if (!isValidGeometry) {
      return {
        ok: false,
        phase: 'execute',
        error: `main() must return a JSCAD geometry object (geom2 or geom3), got: ${typeof value}`
      }
    }

    return {
      ok: true,
      resultType: value.type,
      geometry: value
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
