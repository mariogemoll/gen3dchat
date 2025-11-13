import { describe, it, expect } from 'vitest'
import { validateJscadCode } from './validate.js'

describe('JSCAD Validation Service', () => {
  describe('AST Security Validation', () => {
    it('should block eval()', async () => {
      const code = `
        function main() {
          eval('console.log("bad")')
          return jscadModeling.primitives.cube({ size: 2 })
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(false)
      expect(result.phase).toBe('validate')
      expect(result.error).toContain('eval()')
    })

    it('should block require()', async () => {
      const code = `
        function main() {
          require('fs')
          return jscadModeling.primitives.cube({ size: 2 })
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(false)
      expect(result.phase).toBe('validate')
      expect(result.error).toContain('require()')
    })

    it('should block import statements', async () => {
      const code = `
        import fs from 'fs'
        function main() {
          return jscadModeling.primitives.cube({ size: 2 })
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(false)
      expect(result.phase).toBe('validate')
      expect(result.error).toContain('import')
    })

    it('should block dynamic import()', async () => {
      const code = `
        function main() {
          import('fs')
          return jscadModeling.primitives.cube({ size: 2 })
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(false)
      expect(result.phase).toBe('validate')
      expect(result.error).toContain('import()')
    })

    it('should block Function constructor', async () => {
      const code = `
        function main() {
          new Function('return 1')()
          return jscadModeling.primitives.cube({ size: 2 })
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(false)
      expect(result.phase).toBe('validate')
      expect(result.error).toContain('Function constructor')
    })

    it('should block access to process', async () => {
      const code = `
        function main() {
          process.exit(0)
          return jscadModeling.primitives.cube({ size: 2 })
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(false)
      expect(result.phase).toBe('validate')
      expect(result.error).toContain('process')
    })

    it('should block access to global', async () => {
      const code = `
        function main() {
          global.something = true
          return jscadModeling.primitives.cube({ size: 2 })
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(false)
      expect(result.phase).toBe('validate')
      expect(result.error).toContain('global')
    })

    it('should block constructor access', async () => {
      const code = `
        function main() {
          const x = {}
          x.constructor.constructor('bad code')()
          return jscadModeling.primitives.cube({ size: 2 })
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(false)
      expect(result.phase).toBe('validate')
      expect(result.error).toContain('constructor')
    })
  })

  describe('JSCAD Primitives', () => {
    it('should validate simple cube', async () => {
      const code = `
        function main() {
          return jscadModeling.primitives.cube({ size: 2 })
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(true)
      expect(result.geometry).toBeDefined()
      expect(result.geometry.polygons).toBeInstanceOf(Array)
      expect(result.geometry.polygons.length).toBe(6)
    })

    it('should validate cuboid with array size', async () => {
      const code = `
        function main() {
          return jscadModeling.primitives.cuboid({ size: [10, 20, 30] })
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(true)
      expect(result.geometry.polygons).toBeInstanceOf(Array)
    })

    it('should validate sphere', async () => {
      const code = `
        function main() {
          return jscadModeling.primitives.sphere({ radius: 5 })
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(true)
      expect(result.geometry.polygons).toBeInstanceOf(Array)
    })

    it('should validate cylinder', async () => {
      const code = `
        function main() {
          return jscadModeling.primitives.cylinder({ radius: 5, height: 10 })
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(true)
      expect(result.geometry.polygons).toBeInstanceOf(Array)
    })

    it('should validate torus', async () => {
      const code = `
        function main() {
          return jscadModeling.primitives.torus({ innerRadius: 5, outerRadius: 10 })
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(true)
      expect(result.geometry.polygons).toBeInstanceOf(Array)
    })
  })

  describe('JSCAD Boolean Operations', () => {
    it('should validate union', async () => {
      const code = `
        function main() {
          const { primitives, booleans } = jscadModeling
          return booleans.union(
            primitives.cuboid({ size: [2, 2, 2] }),
            primitives.sphere({ radius: 1.5 })
          )
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(true)
      expect(result.geometry.polygons).toBeInstanceOf(Array)
      expect(result.geometry.polygons.length).toBeGreaterThan(0)
    })

    it('should validate subtract', async () => {
      const code = `
        function main() {
          const { primitives, booleans } = jscadModeling
          return booleans.subtract(
            primitives.sphere({ radius: 10 }),
            primitives.cylinder({ radius: 5, height: 30 })
          )
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(true)
      expect(result.geometry.polygons).toBeInstanceOf(Array)
    })

    it('should validate intersect', async () => {
      const code = `
        function main() {
          const { primitives, booleans } = jscadModeling
          return booleans.intersect(
            primitives.cube({ size: 10 }),
            primitives.sphere({ radius: 7 })
          )
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(true)
      expect(result.geometry.polygons).toBeInstanceOf(Array)
    })
  })

  describe('JSCAD Transformations', () => {
    it('should validate translate', async () => {
      const code = `
        function main() {
          const { primitives, transforms } = jscadModeling
          return transforms.translate([5, 10, 15], primitives.cube({ size: 2 }))
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(true)
      expect(result.geometry.polygons).toBeInstanceOf(Array)
    })

    it('should validate rotate', async () => {
      const code = `
        function main() {
          const { primitives, transforms } = jscadModeling
          return transforms.rotate([0, 0, Math.PI / 4], primitives.cuboid({ size: [10, 5, 2] }))
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(true)
      expect(result.geometry.polygons).toBeInstanceOf(Array)
    })

    it('should validate scale', async () => {
      const code = `
        function main() {
          const { primitives, transforms } = jscadModeling
          return transforms.scale([2, 1, 0.5], primitives.cube({ size: 10 }))
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(true)
      expect(result.geometry.polygons).toBeInstanceOf(Array)
    })
  })

  describe('JSCAD Module Access', () => {
    it('should allow jscadModeling.primitives access', async () => {
      const code = `
        function main() {
          return jscadModeling.primitives.cube({ size: 5 })
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(true)
      expect(result.geometry.polygons).toBeInstanceOf(Array)
    })

    it('should allow jscadModeling.booleans access', async () => {
      const code = `
        function main() {
          const { primitives, booleans } = jscadModeling
          return booleans.union(
            primitives.cube({ size: 5 }),
            primitives.sphere({ radius: 4 })
          )
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(true)
      expect(result.geometry.polygons).toBeInstanceOf(Array)
    })

    it('should allow jscadModeling.transforms access', async () => {
      const code = `
        function main() {
          return jscadModeling.transforms.translate(
            [10, 0, 0],
            jscadModeling.primitives.cylinder({ radius: 3, height: 10 })
          )
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(true)
      expect(result.geometry.polygons).toBeInstanceOf(Array)
    })
  })

  describe('Complex Geometries', () => {
    it('should validate complex nested operations', async () => {
      const code = `
        function main() {
          const { primitives, booleans, transforms } = jscadModeling
          const base = primitives.cuboid({ size: [20, 20, 5] })
          const hole1 = primitives.cylinder({ radius: 3, height: 10 })
          const hole2 = primitives.cylinder({ radius: 3, height: 10 })

          return booleans.subtract(
            base,
            transforms.translate([5, 5, 0], hole1),
            transforms.translate([-5, -5, 0], hole2)
          )
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(true)
      expect(result.geometry.polygons).toBeInstanceOf(Array)
    })

    it('should validate with hull operations', async () => {
      const code = `
        function main() {
          const { primitives, transforms, hulls } = jscadModeling
          return hulls.hull(
            transforms.translate([0, 0, 0], primitives.sphere({ radius: 5 })),
            transforms.translate([20, 0, 0], primitives.sphere({ radius: 5 })),
            transforms.translate([10, 20, 0], primitives.sphere({ radius: 5 }))
          )
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(true)
      expect(result.geometry.polygons).toBeInstanceOf(Array)
    })
  })

  describe('Error Handling', () => {
    it('should fail if main() is not defined', async () => {
      const code = `
        function notMain() {
          return jscadModeling.primitives.cube({ size: 2 })
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(false)
      expect(result.phase).toBe('execute')
      expect(result.error).toContain('main()')
    })

    it('should fail if main() does not return geometry', async () => {
      const code = `
        function main() {
          return "not a geometry"
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(false)
      expect(result.phase).toBe('execute')
      expect(result.error).toContain('geometry object')
    })

    it('should fail on runtime errors', async () => {
      const code = `
        function main() {
          return jscadModeling.primitives.cube({ size: -5 })
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(false)
      expect(result.phase).toBe('execute')
    })

    it('should timeout on infinite loops', async () => {
      const code = `
        function main() {
          while(true) {}
          return jscadModeling.primitives.cube({ size: 2 })
        }
      `
      const result = await validateJscadCode(code)
      expect(result.ok).toBe(false)
      expect(result.phase).toBe('execute')
      expect(result.error).toContain('timed out')
    }, 10000) // 10 second test timeout to allow for 5 second VM timeout
  })
})
