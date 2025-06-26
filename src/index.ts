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
const SYSTEM_PROMPT =
  "You are a helpful, friendly assistant. Provide concise and accurate responses.";

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
      max_num_results: 3,         // number of docs to retrieve
      rewrite_query: true,        // optional: improve query quality
      ranking_options: {
        score_threshold: 0.3,     // optional: ignore poor matches
      },
    });

    console.log("RAG searchResponse.data:", JSON.stringify(searchResponse.data, null, 2));

    // Format the retrieved docs into a single string
    const retrievedDocs = searchResponse.data
      .map(match => match.content.map(content => content.text).join("\n\n"))
      .join("\n\n---\n\n");

    console.log("RAG retrievedDocs:", retrievedDocs);


    // Inject the retrieved docs as a system message right after the initial system prompt
    messages.splice(1, 0, {
      role: "system",
      content: `Here are some relevant documents that might help:\n\n${retrievedDocs}`,
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
