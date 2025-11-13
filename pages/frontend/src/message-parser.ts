export interface ParsedMessage {
  role: 'user' | 'assistant'
  content: string
}

export function parseMessage(msg: any): ParsedMessage {
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

  return {
    role,
    content: content || '[Empty message]'
  }
}
