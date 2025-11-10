const messagesContainer = document.querySelector<HTMLDivElement>('#messages')!
const form = document.querySelector<HTMLFormElement>('#chatForm')!
const input = document.querySelector<HTMLInputElement>('#chatInput')!
const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!

let threadId: string | null = null
const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []

function addMessage(role: 'user' | 'assistant', content: string) {
  messages.push({ role, content })

  const messageEl = document.createElement('div')
  messageEl.className = `message ${role}`

  const avatar = document.createElement('div')
  avatar.className = 'avatar'
  avatar.textContent = role === 'user' ? '👤' : '🤖'

  const contentEl = document.createElement('div')
  contentEl.className = 'content'
  contentEl.textContent = content

  messageEl.appendChild(avatar)
  messageEl.appendChild(contentEl)
  messagesContainer.appendChild(messageEl)

  // Scroll to bottom
  messagesContainer.scrollTop = messagesContainer.scrollHeight
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault()

  const message = input.value.trim()
  if (!message) return

  // Add user message
  addMessage('user', message)
  input.value = ''
  submitBtn.disabled = true

  try {
    const res = await fetch('/api/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, threadId }),
    })

    const data = await res.json()

    if (data.error) {
      addMessage('assistant', `Error: ${data.error}`)
    } else {
      // Store thread ID for subsequent messages
      threadId = data.threadId
      addMessage('assistant', data.response)
      console.log('Thread ID:', threadId, 'Messages:', data.messageCount)
    }
  } catch (e) {
    addMessage('assistant', `Error: ${String(e)}`)
  } finally {
    submitBtn.disabled = false
    input.focus()
  }
})