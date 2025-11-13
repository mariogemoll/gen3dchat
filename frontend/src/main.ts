import { UIManager } from './ui'
import { AppState } from './state'
import { sendMessage, loadCheckpointData } from './api'
import { parseMessage } from './message-parser'

const input = document.querySelector<HTMLInputElement>('#chatInput')!
const sendBtn = document.querySelector<HTMLButtonElement>('#sendButton')!

const ui = new UIManager()
const state = new AppState()

function updateSaveButtonState() {
  state.markCodeAsChanged(ui.getCodeEditorValue())
  ui.updateSaveButton(!state.hasUnsavedChanges)
}

function updateCodeEditor(code: string) {
  state.updateSavedCode(code)
  ui.setCodeEditorValue(code)
  updateSaveButtonState()
}

async function saveCode(): Promise<boolean> {
  const code = ui.getCodeEditorValue()

  // Show loading label
  ui.addUpdateLabel(true)
  ui.updateSaveButton(true)

  try {
    const { data, isOwner } = await sendMessage(
      '```javascript\n' + code + '\n```',
      state.threadId
    )

    if (!isOwner) {
      ui.updateLoadingLabel(false)
      ui.addMessage('assistant', 'Error: You are not authorized to continue this conversation.')
      state.updateOwnership(false)
      ui.hideChatForm()
      return false
    } else if (data.error) {
      ui.updateLoadingLabel(false)
      ui.addMessage('assistant', `Error: ${data.error}`)
      return false
    } else {
      // Check if validation failed by looking at the response message
      const isValidationError = data.response && data.response.includes('Validation error:')

      if (isValidationError) {
        // Validation failed - show popup, don't add to chat
        ui.updateLoadingLabel(false)
        ui.showAlert(data.response!)

        return false
      } else {
        // Validation succeeded
        ui.updateLoadingLabel(true)

        // Update state
        if (data.currentCode !== undefined) {
          updateCodeEditor(data.currentCode)
        }

        // Update URL with thread and checkpoint
        if (data.threadId && data.checkpointId) {
          updateURL(data.threadId, data.checkpointId)
        }

        console.log('Code saved. Thread ID:', data.threadId, 'Checkpoint ID:', data.checkpointId)
        return true
      }
    }
  } catch (e) {
    ui.updateLoadingLabel(false)
    ui.addMessage('assistant', `Error: ${String(e)}`)
    return false
  } finally {
    updateSaveButtonState()
  }
}

function updateURL(newThreadId: string, newCheckpointId: string) {
  state.updateThreadInfo(newThreadId, newCheckpointId)
  const newUrl = `/${newThreadId}/${newCheckpointId}`
  window.history.pushState({ threadId: newThreadId, checkpointId: newCheckpointId }, '', newUrl)
}

async function loadCheckpoint(loadThreadId: string, loadCheckpointId: string) {
  try {
    const { data, isOwner } = await loadCheckpointData(loadThreadId, loadCheckpointId)

    if (data.error) {
      console.error('Error loading checkpoint:', data.error)
      return
    }

    // Clear existing messages
    ui.clearMessages()

    // Load current code from checkpoint if available
    if (data.checkpoint?.channel_values?.currentCode !== undefined) {
      updateCodeEditor(data.checkpoint.channel_values.currentCode)
    }

    // Render messages from checkpoint
    if (data.checkpoint?.channel_values?.messages) {
      const messages = data.checkpoint.channel_values.messages

      for (const msg of messages) {
        const parsed = parseMessage(msg)
        ui.addMessage(parsed.role, parsed.content)
      }
    }

    // Update state
    state.updateThreadInfo(loadThreadId, loadCheckpointId)
    state.updateOwnership(isOwner)

    if (isOwner) {
      ui.showChatForm()
    } else {
      ui.hideChatForm()
    }
  } catch (e) {
    console.error('Error loading checkpoint:', e)
    ui.addMessage('assistant', `Error loading checkpoint: ${String(e)}`)
    // On error, hide the form to be safe
    state.updateOwnership(false)
    ui.hideChatForm()
  }
}

// Handle browser back/forward
window.addEventListener('popstate', (event) => {
  if (event.state?.threadId && event.state?.checkpointId) {
    loadCheckpoint(event.state.threadId, event.state.checkpointId)
  } else {
    // Back to home - clear everything
    ui.clearMessages()
    state.reset()
    ui.showChatForm()
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

document.querySelector<HTMLFormElement>('#chatForm')!.addEventListener('submit', async (ev) => {
  ev.preventDefault()

  const message = input.value.trim()
  if (!message) return

  // If code has unsaved changes, save it first
  if (state.hasUnsavedChanges) {
    const saved = await saveCode()
    if (!saved) {
      // If save failed, don't proceed with the message
      return
    }
  }

  // Add user message
  ui.addMessage('user', message)
  input.value = ''
  sendBtn.disabled = true

  try {
    const { data, isOwner } = await sendMessage(message, state.threadId)

    if (!isOwner) {
      // Not authorized
      ui.addMessage('assistant', 'Error: You are not authorized to continue this conversation.')
      state.updateOwnership(false)
      ui.hideChatForm()
    } else if (data.error) {
      ui.addMessage('assistant', `Error: ${data.error}`)
    } else {
      // Update code editor if code changed
      if (data.currentCode !== undefined) {
        updateCodeEditor(data.currentCode)
      }

      // Add assistant response
      ui.addMessage('assistant', data.response!)

      // Update URL with thread and checkpoint
      if (data.threadId && data.checkpointId) {
        updateURL(data.threadId, data.checkpointId)
      }

      console.log('Thread ID:', data.threadId, 'Checkpoint ID:', data.checkpointId, 'Messages:', data.messageCount)
    }
  } catch (e) {
    ui.addMessage('assistant', `Error: ${String(e)}`)
  } finally {
    sendBtn.disabled = false
    input.focus()
  }
})

// Code editor change listener
document.querySelector<HTMLTextAreaElement>('#codeEditor')!.addEventListener('input', () => {
  updateSaveButtonState()
})

// Save button click handler
document.querySelector<HTMLButtonElement>('#saveButton')!.addEventListener('click', async () => {
  await saveCode()
})