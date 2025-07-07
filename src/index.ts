import { Hono } from 'hono'
import type { Env, ChatMessage } from './types'

const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"

const SYSTEM_PROMPT = `You are a technically accurate assistant for SONiC NOS. You receive real-time document context using a retrieval system (RAG).
This content appears in a system message.
If no documents are found, you will inform the user that no RAG failed to find any documents.
Use markdown and code blocks. Your users are network engineers or operators. Never guess or make up commands.`

const app = new Hono<{ Bindings: Env }>()

// API route for chat
app.post('/api/chat', async (c) => {
  return handleChatRequest(c)
})

export default app

async function handleChatRequest(c: Parameters<typeof app.post>[1]) {
  try {
    const { messages = [] } = (await c.req.json()) as { messages: ChatMessage[] }

    if (!messages.some((msg) => msg.role === 'system')) {
      messages.unshift({ role: 'system', content: SYSTEM_PROMPT })
    }

    // Extract last user message for RAG query
    const lastUserMessage =
      [...messages].reverse().find((msg) => msg.role === 'user')?.content || ''

    // Call AutoRAG search
    const searchResponse = await c.env.AI.autorag('sonic-helper').search({
      query: lastUserMessage,
      max_num_results: 3,
      rewrite_query: true,
      ranking_options: { score_threshold: 0.3 },
    })

    console.log('RAG searchResponse.data:', JSON.stringify(searchResponse.data, null, 2))

    const retrievedDocs = searchResponse.data
      .map((match) => {
        const source = match.filename || match.file_id
        const body = match.content.map((c) => c.text).join('\n\n')
        return `Source: ${source}\nScore: ${match.score}\n\n${body}`
      })
      .join('\n\n---\n\n')

    const sortedResults = [...searchResponse.data].sort((a, b) => b.score - a.score)
    let table = '\n\n\n---\n\n\n| Filename | Score |\n| --- | --- |\n'
    for (const match of sortedResults) {
      const filename = match.filename || match.file_id || 'Unknown'
      const score = match.score.toFixed(3)
      table += `| ${filename} | ${score} |\n`
    }

    const ragPrompt =
      searchResponse.data.length > 0
        ? `RAG documents found. The following documents were retrieved from the SONiC knowledge base. 
         Each document has a relevance score; please prioritize information from documents with higher scores.:\n\n${retrievedDocs}
         At the end of your answer always add 2 empty lines, a horizontal line and the following text: ${table}`
        : `RAG documents not found. Inform the user no information from the knowledge base will be used.`

    messages.splice(1, 0, {
      role: 'system',
      content: ragPrompt,
    })

    const response = await c.env.AI.run(
      MODEL_ID,
      {
        messages,
        max_tokens: 1024,
      },
      {
        returnRawResponse: true,
      }
    )

    return response
  } catch (error) {
    console.error('Error processing chat request:', error)
    return c.json({ error: 'Failed to process request' }, 500)
  }
}
