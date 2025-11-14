// functions/lib/jscad-validator.ts

/**
 * Client for calling the external JSCAD validation service
 * The validation service runs QuickJS sandboxing on Vercel Functions
 */

interface ValidationResult {
  ok: boolean
  phase?: 'validate' | 'execute'
  error?: string
  resultType?: string
  geometry?: any
}

/**
 * Validates JSCAD code by calling the external validation service
 * The validation service runs QuickJS in a proper Node.js environment (Vercel)
 */
export async function validateJscadCode(code: string, validationServiceUrl?: string): Promise<ValidationResult> {
  const serviceUrl = validationServiceUrl || process.env.JSCAD_VALIDATION_SERVICE_URL

  if (!serviceUrl) {
    return {
      ok: false,
      phase: 'validate',
      error: 'Validation service not configured. Set JSCAD_VALIDATION_SERVICE_URL environment variable.'
    }
  }

  try {
    const response = await fetch(serviceUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(10000), // 10 second timeout
    })

    if (!response.ok) {
      const error: any = await response.json().catch(() => ({ error: 'Unknown error' }))
      return {
        ok: false,
        phase: 'execute',
        error: error.error || `Validation service returned ${response.status}`
      }
    }

    const result: ValidationResult = await response.json()
    return result
  } catch (e: any) {
    return {
      ok: false,
      phase: 'execute',
      error: `Validation service error: ${e.message || String(e)}`
    }
  }
}
