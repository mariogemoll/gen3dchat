const messagesContainer = document.querySelector<HTMLDivElement>('#messages')!
const form = document.querySelector<HTMLFormElement>('#chatForm')!
const input = document.querySelector<HTMLInputElement>('#chatInput')!
const sendBtn = document.querySelector<HTMLButtonElement>('#sendButton')!
const codeEditor = document.querySelector<HTMLTextAreaElement>('#codeEditor')!
const saveButton = document.querySelector<HTMLButtonElement>('#saveButton')!

let threadId: string | null = null
let checkpointId: string | null = null
let isOwner: boolean = true // Start as true for new conversations
let savedCode: string = ''
let hasUnsavedChanges: boolean = false

function showChatForm() {
  form.style.display = 'flex'
}

function hideChatForm() {
  form.style.display = 'none'
}

function updateSaveButtonState() {
  hasUnsavedChanges = codeEditor.value !== savedCode
  saveButton.disabled = !hasUnsavedChanges
}

function updateCodeEditor(code: string) {
  savedCode = code
  codeEditor.value = code
  updateSaveButtonState()
}

async function saveCode(): Promise<boolean> {
  const code = codeEditor.value

  // Show loading label
  addUpdateLabel(true)

  saveButton.disabled = true

  try {
    const res = await fetch('/api/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: '```simple\n' + code + '\n```',
        threadId
      }),
    })

    const data = await res.json()

    if (res.status === 403) {
      updateLoadingLabel(false)
      addMessage('assistant', 'Error: You are not authorized to continue this conversation.')
      isOwner = false
      hideChatForm()
      return false
    } else if (data.error) {
      updateLoadingLabel(false)
      addMessage('assistant', `Error: ${data.error}`)
      return false
    } else {
      // Check if validation failed by looking at the response message
      const isValidationError = data.response && data.response.includes('Validation error:')

      if (isValidationError) {
        // Validation failed - show popup, don't add to chat
        updateLoadingLabel(false)
        alert(data.response) // Show browser alert

        // Don't update URL/checkpoint for invalid code

        return false
      } else {
        // Validation succeeded
        updateLoadingLabel(true)

        // Update state
        if (data.currentCode !== undefined) {
          updateCodeEditor(data.currentCode)
        }

        // Don't add any message for user code updates

        // Update URL with thread and checkpoint
        if (data.threadId && data.checkpointId) {
          updateURL(data.threadId, data.checkpointId)
        }

        console.log('Code saved. Thread ID:', data.threadId, 'Checkpoint ID:', data.checkpointId)
        return true
      }
    }
  } catch (e) {
    updateLoadingLabel(false)
    addMessage('assistant', `Error: ${String(e)}`)
    return false
  } finally {
    updateSaveButtonState()
  }
}

function addMessage(role: 'user' | 'assistant', content: string) {
  // Filter out code blocks from the content
  const textOnly = content.replace(/```[\s\S]*?```/g, '').trim()

  // Skip if no text content after removing code blocks
  if (!textOnly) return

  const messageEl = document.createElement('div')
  messageEl.className = `message ${role}`

  const avatar = document.createElement('div')
  avatar.className = 'avatar'
  avatar.textContent = role === 'user' ? 'U' : 'A'

  const contentEl = document.createElement('div')
  contentEl.className = 'content'
  contentEl.textContent = textOnly

  messageEl.appendChild(avatar)
  messageEl.appendChild(contentEl)
  messagesContainer.appendChild(messageEl)

  // Scroll to bottom
  messagesContainer.scrollTop = messagesContainer.scrollHeight
}

function addUpdateLabel(loading: boolean = false) {
  const updateEl = document.createElement('div')
  updateEl.className = `update-label ${loading ? 'loading' : ''}`
  updateEl.id = loading ? 'updating-label' : ''
  updateEl.textContent = loading ? 'Updating...' : 'Code Updated'
  messagesContainer.appendChild(updateEl)

  // Scroll to bottom
  messagesContainer.scrollTop = messagesContainer.scrollHeight

  return updateEl
}

function updateLoadingLabel(success: boolean) {
  const loadingLabel = document.getElementById('updating-label')
  if (loadingLabel) {
    loadingLabel.className = 'update-label'
    loadingLabel.id = ''
    loadingLabel.textContent = success ? 'Code Updated' : 'Update Failed'
  }
}

function clearMessages() {
  messagesContainer.innerHTML = ''
}

function updateURL(newThreadId: string, newCheckpointId: string) {
  threadId = newThreadId
  checkpointId = newCheckpointId
  const newUrl = `/${threadId}/${checkpointId}`
  window.history.pushState({ threadId, checkpointId }, '', newUrl)
}

async function loadCheckpoint(loadThreadId: string, loadCheckpointId: string) {
  try {
    const res = await fetch(`/api/threads/${loadThreadId}/${loadCheckpointId}`)

    if (!res.ok) {
      throw new Error(`Failed to load checkpoint: ${res.statusText}`)
    }

    const data = await res.json()

    if (data.error) {
      console.error('Error loading checkpoint:', data.error)
      return
    }

    // Clear existing messages
    clearMessages()

    // Load current code from checkpoint if available
    if (data.checkpoint?.channel_values?.currentCode !== undefined) {
      updateCodeEditor(data.checkpoint.channel_values.currentCode)
    }

    // Render messages from checkpoint
    if (data.checkpoint?.channel_values?.messages) {
      const messages = data.checkpoint.channel_values.messages

      for (const msg of messages) {
        // Check if message is in LangChain serialized format
        const isHuman = msg.id?.[2] === 'HumanMessage' ||
          msg.type === 'human' ||
          msg.role === 'human'
        const role = isHuman ? 'user' : 'assistant'

        // Extract content from kwargs if it exists (LangChain serialized format)
        let content = msg.kwargs?.content || msg.content

        // Handle different content formats
        if (typeof content === 'object' && content !== null && !Array.isArray(content)) {
          content = content.text || content.content || JSON.stringify(content)
        } else if (Array.isArray(content)) {
          content = content.map((c: any) => typeof c === 'string' ? c : c.text || c.content || '').join('')
        }

        addMessage(role, content || '[Empty message]')
      }
    }

    // Update state
    threadId = loadThreadId
    checkpointId = loadCheckpointId

    // Check ownership from response header
    const ownerHeader = res.headers.get('X-Thread-Owner')
    isOwner = ownerHeader === 'true'

    if (isOwner) {
      showChatForm()
    } else {
      hideChatForm()
    }
  } catch (e) {
    console.error('Error loading checkpoint:', e)
    addMessage('assistant', `Error loading checkpoint: ${String(e)}`)
    // On error, hide the form to be safe
    isOwner = false
    hideChatForm()
  }
}

// Handle browser back/forward
window.addEventListener('popstate', (event) => {
  if (event.state?.threadId && event.state?.checkpointId) {
    loadCheckpoint(event.state.threadId, event.state.checkpointId)
  } else {
    // Back to home - clear everything
    clearMessages()
    threadId = null
    checkpointId = null
    isOwner = true
    showChatForm()
  }
})

// Load checkpoint on initial page load if URL matches pattern
function checkInitialURL() {
  const path = window.location.pathname
  const match = path.match(/^\/([^/]+)\/([^/]+)$/)

  if (match) {
    const [, urlThreadId, urlCheckpointId] = match
    loadCheckpoint(urlThreadId, urlCheckpointId)
  }
}

// Check URL on load
checkInitialURL()

form.addEventListener('submit', async (ev) => {
  ev.preventDefault()

  const message = input.value.trim()
  if (!message) return

  // If code has unsaved changes, save it first
  if (hasUnsavedChanges) {
    const saved = await saveCode()
    if (!saved) {
      // If save failed, don't proceed with the message
      return
    }
  }

  // Add user message
  addMessage('user', message)
  input.value = ''
  sendBtn.disabled = true

  try {
    const res = await fetch('/api/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, threadId }),
    })

    const data = await res.json()

    if (res.status === 403) {
      // Not authorized
      addMessage('assistant', 'Error: You are not authorized to continue this conversation.')
      isOwner = false
      hideChatForm()
    } else if (data.error) {
      addMessage('assistant', `Error: ${data.error}`)
    } else {
      // Update code editor if code changed
      if (data.currentCode !== undefined) {
        updateCodeEditor(data.currentCode)
      }

      // Add assistant response
      addMessage('assistant', data.response)

      // Update URL with thread and checkpoint
      if (data.threadId && data.checkpointId) {
        updateURL(data.threadId, data.checkpointId)
      }

      console.log('Thread ID:', data.threadId, 'Checkpoint ID:', data.checkpointId, 'Messages:', data.messageCount)
    }
  } catch (e) {
    addMessage('assistant', `Error: ${String(e)}`)
  } finally {
    sendBtn.disabled = false
    input.focus()
  }
})

// Code editor change listener
codeEditor.addEventListener('input', () => {
  updateSaveButtonState()
})

// Save button click handler
saveButton.addEventListener('click', async () => {
  await saveCode()
})