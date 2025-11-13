export interface ThreadResponse {
  error?: string
  response?: string
  currentCode?: string
  threadId?: string
  checkpointId?: string
  messageCount?: number
}

export interface CheckpointResponse {
  error?: string
  checkpoint?: {
    channel_values?: {
      currentCode?: string
      messages?: Array<{
        id?: any[]
        type?: string
        role?: string
        kwargs?: {
          content?: any
        }
        content?: any
      }>
    }
  }
}

export async function sendMessage(
  message: string,
  threadId: string | null
): Promise<{ data: ThreadResponse; isOwner: boolean }> {
  const res = await fetch('/api/threads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, threadId }),
  })

  const data = await res.json()
  const isOwner = res.status !== 403

  return { data, isOwner }
}

export async function loadCheckpointData(
  threadId: string,
  checkpointId: string
): Promise<{ data: CheckpointResponse; isOwner: boolean }> {
  const res = await fetch(`/api/threads/${threadId}/${checkpointId}`)

  if (!res.ok) {
    throw new Error(`Failed to load checkpoint: ${res.statusText}`)
  }

  const data = await res.json()
  const ownerHeader = res.headers.get('X-Thread-Owner')
  const isOwner = ownerHeader === 'true'

  return { data, isOwner }
}
