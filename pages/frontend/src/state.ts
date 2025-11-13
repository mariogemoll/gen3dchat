export class AppState {
  threadId: string | null = null
  checkpointId: string | null = null
  isOwner: boolean = true
  savedCode: string = ''
  hasUnsavedChanges: boolean = false

  updateThreadInfo(threadId: string, checkpointId: string) {
    this.threadId = threadId
    this.checkpointId = checkpointId
  }

  updateOwnership(isOwner: boolean) {
    this.isOwner = isOwner
  }

  updateSavedCode(code: string) {
    this.savedCode = code
    this.hasUnsavedChanges = false
  }

  markCodeAsChanged(currentCode: string) {
    this.hasUnsavedChanges = currentCode !== this.savedCode
  }

  reset() {
    this.threadId = null
    this.checkpointId = null
    this.isOwner = true
    this.savedCode = ''
    this.hasUnsavedChanges = false
  }
}
