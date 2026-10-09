# DRIP — tech stack

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | Node.js, VS Code Extension API | DRIP lives inside VS Code as an extension; the API provides the editor, tree views, and webviews it needs |
| Language | JavaScript (CommonJS) with JSDoc types | Matches the existing extension host setup; types are checked with `tsgo` without a full TS build |
| UI | Tree views + webview panels | Tree views for the sidebar lists; webviews for rich panels (Composer, Retriever, Project View, Tags, Chat) |
| Index | `better-sqlite3` | A fast, local, synchronous SQLite database that stores headings, metadata, tags, issues, and projects. No external SQLite extensions are loaded |
| Vector search | Plain SQLite BLOB + in-JS scan | Vectors are stored as `Float32Array` BLOBs in ordinary tables; similarity is a single exact L2 scan done in JavaScript. One search path for every vector count, with no native vector library |
| Embeddings | `@xenova/transformers` (ONNX) | Runs a sentence-embedding model locally (no API calls) to turn text into vectors |
| MCP server | Node `http` (Streamable HTTP) | A lightweight local server so any MCP-capable AI app can query and manage DRIP issues |
| LLM chat | OpenAI-compatible HTTP API | Chat + long-term memory using any OpenAI-compatible endpoint (OpenAI, Groq, Ollama, etc.) |
| Backup | `git` (system binary) | Reuses the user's Git install to push/pull the KB to GitHub; a PAT is stored in VS Code Secret Storage |
| Type checking | `tsgo --project tsconfig.json --noEmit` | Fast JS type checking without emitting JS |

## Optional dependencies

The embeddings stack (`@xenova/transformers`) downloads a model on first use into the extension's cache folder, not the system Hugging Face cache. Embeddings can be disabled in settings.

## Native dependency policy

`better-sqlite3` is the only native dependency. Vector storage and search are pure JavaScript and plain SQLite tables, so there is nothing platform-specific to load or ship — the same build works on Windows and macOS.
