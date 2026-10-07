# Feature: LLM chat

## What it is

A Chat panel in the right sidebar lets the user talk to an AI assistant that is aware of the knowledge base, with short-term session context and long-term memory.

## How to access it

- Lives in the right (secondary) sidebar as the **Chat** view.
- Open it with the **Open DRIP Chat** command, or click the DRIP activity bar then **Chat**. Use **Add Selection to Chat** to include the current text.

## Sub-features

### Chat panel

- A webview chat UI in the secondary sidebar.
- The user can add the current selection to the chat input.

### LLM client

- Talks to any OpenAI-compatible chat-completions endpoint (OpenAI, Groq, Ollama, etc.).
- Base URL, model, and API key are configured in settings; the key is stored in VS Code Secret Storage.

### Long-term memory

- One plain-text file per KB (`.dripindex/chat-memory.md`) stores durable memory items.
- The LLM can add/remove items when the user says to remember or forget something; the user can also edit the file directly.
- Memory sent to the model is capped to keep requests small.

### Session memory

- Short-term context for the current session, cleared on reload.

## Flow (plain steps)

1. User opens the Chat panel and types a message (optionally including a selection).
2. The request is sent to the configured LLM along with the long-term memory.
3. When the user asks DRIP to remember/forget something, the memory file is updated and used in future requests.
