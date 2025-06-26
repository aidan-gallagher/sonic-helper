/**
 * LLM Chat Application Template
 *
 * A simple chat application using Cloudflare Workers AI.
 * This template demonstrates how to implement an LLM-powered chat interface with
 * streaming responses using Server-Sent Events (SSE).
 *
 * @license MIT
 */
import { Env, ChatMessage } from "./types";

// Model ID for Workers AI model
// https://developers.cloudflare.com/workers-ai/models/
const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Default system prompt
const SYSTEM_PROMPT = `You are a technically accurate assistant for SONiC NOS. You receive real-time document context using a retrieval system (RAG).
This content appears in a system message.
If no documents are found, you will inform the user..
Use markdown and code blocks. Your users are network engineers or operators. Never guess or make up commands.`;

export default {
  /**
   * Main request handler for the Worker
   */
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Handle static assets (frontend)
    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    // API Routes
    if (url.pathname === "/api/chat") {
      // Handle POST requests for chat
      if (request.method === "POST") {
        return handleChatRequest(request, env);
      }

      // Method not allowed for other request types
      return new Response("Method not allowed", { status: 405 });
    }

    // Handle 404 for unmatched routes
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Handles chat API requests
 */
async function handleChatRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    // Parse JSON request body
    const { messages = [] } = (await request.json()) as {
      messages: ChatMessage[];
    };

    // Add system prompt if not present
    if (!messages.some((msg) => msg.role === "system")) {
      messages.unshift({ role: "system", content: SYSTEM_PROMPT });
    }

    /* ------------------ Retrieval Augmented Generation Start ------------------ */
    // Extract last user message (to use as query)
    const lastUserMessage = [...messages].reverse().find(msg => msg.role === "user")?.content || "";

    // Query AutoRAG vector DB
    const searchResponse = await env.AI.autorag("sonic-helper").search({
      query: lastUserMessage,
      max_num_results: 3,        
      rewrite_query: true,       
      ranking_options: {
        score_threshold: 0.3,     
      },
    });

    console.log("RAG searchResponse.data:", JSON.stringify(searchResponse.data, null, 2));

    // Format the retrieved docs into a single string
    const retrievedDocs = searchResponse.data
      .map((match) => {
        const source = match.filename || match.file_id;
        const body = match.content.map((c) => c.text).join("\n\n");
        return `Source: ${source}\nScore: ${match.score}\n\n${body}`;
      })
      .join("\n\n---\n\n");

    console.log("RAG retrievedDocs:", retrievedDocs);

    // Create Table of sources
    const sortedResults = [...searchResponse.data].sort((a, b) => b.score - a.score);
    let table = `\n\n\n---\n\n\n The following files from the knowledge base were used \n\n\n| Filename | Score |\n| --- | --- |\n`;
    for (const match of sortedResults) {
      const filename = match.filename || match.file_id || "Unknown";
      const score = match.score.toFixed(3);
      table += `| ${filename} | ${score} |\n`;
    }

    const ragPrompt = searchResponse.data.length > 0
      ? `Documents found. The following documents were retrieved from the SONiC knowledge base. 
         Each document has a relevance score; please prioritize information from documents with higher scores.:\n\n${retrievedDocs}
         Always add the following text and table to very end of your answer ${table}`
      : `Document not found. Inform the user no information from the knowledge base will be used.`;

    messages.splice(1, 0, {
      role: "system",
      content: ragPrompt,
    });

    /* ------------------ Retrieval Augmented Generation End ------------------ */

    const response = await env.AI.run(
      MODEL_ID,
      {
        messages,
        max_tokens: 1024,
      },
      {
        returnRawResponse: true,
        // Uncomment to use AI Gateway
        // gateway: {
        //   id: "YOUR_GATEWAY_ID", // Replace with your AI Gateway ID
        //   skipCache: false,      // Set to true to bypass cache
        //   cacheTtl: 3600,        // Cache time-to-live in seconds
        // },
      },
    );

    // Return streaming response
    return response;
  } catch (error) {
    console.error("Error processing chat request:", error);
    return new Response(
      JSON.stringify({ error: "Failed to process request" }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      },
    );
  }
}
