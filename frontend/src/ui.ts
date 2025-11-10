export class UIManager {
  private messagesContainer: HTMLDivElement
  private form: HTMLFormElement
  private codeEditor: HTMLTextAreaElement
  private saveButton: HTMLButtonElement

  constructor() {
    this.messagesContainer = document.querySelector<HTMLDivElement>('#messages')!
    this.form = document.querySelector<HTMLFormElement>('#chatForm')!
    this.codeEditor = document.querySelector<HTMLTextAreaElement>('#codeEditor')!
    this.saveButton = document.querySelector<HTMLButtonElement>('#saveButton')!
  }

  showChatForm() {
    this.form.style.display = 'flex'
  }

  hideChatForm() {
    this.form.style.display = 'none'
  }

  updateSaveButton(disabled: boolean) {
    this.saveButton.disabled = disabled
  }

  getCodeEditorValue(): string {
    return this.codeEditor.value
  }

  setCodeEditorValue(code: string) {
    this.codeEditor.value = code
  }

  addMessage(role: 'user' | 'assistant', content: string) {
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
    this.messagesContainer.appendChild(messageEl)

    // Scroll to bottom
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight
  }

  addUpdateLabel(loading: boolean = false) {
    const updateEl = document.createElement('div')
    updateEl.className = `update-label ${loading ? 'loading' : ''}`
    updateEl.id = loading ? 'updating-label' : ''
    updateEl.textContent = loading ? 'Updating...' : 'Code Updated'
    this.messagesContainer.appendChild(updateEl)

    // Scroll to bottom
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight

    return updateEl
  }

  updateLoadingLabel(success: boolean) {
    const loadingLabel = document.getElementById('updating-label')
    if (loadingLabel) {
      loadingLabel.className = 'update-label'
      loadingLabel.id = ''
      loadingLabel.textContent = success ? 'Code Updated' : 'Update Failed'
    }
  }

  clearMessages() {
    this.messagesContainer.innerHTML = ''
  }

  showAlert(message: string) {
    alert(message)
  }
}
