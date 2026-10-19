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
- Settings hold one or more named **provider profiles**, each with its own base URL, model, enable toggle, and API key. The key is stored in VS Code Secret Storage (never in settings) and is never shown again after saving.
- One profile is **active** at a time — Quick Capture, ingest, and chat all use the active profile.
- From the LLM settings panel the user can add, edit (name / base URL / model / enabled), delete, and switch profiles, and set or clear each profile's API key independently.
- Each profile has a **Test connection** button that sends a tiny one-word request to the provider to verify the base URL, model, and saved key work, then shows a success/error line on the card.

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
