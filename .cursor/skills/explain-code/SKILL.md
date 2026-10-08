---
name: explain-code
description: Explains code and architecture in plain, simple language with a clear end-to-end flow (input → process → output) and concrete code snippets with file paths and line numbers. Use when the user asks to understand how code works, how a feature or module works end-to-end, to walk through a function or file, or asks "what does this do".
disable-model-invocation: false
---

# Explain Code

Explain code the way you'd teach a colleague — plain words, the actual flow, and real snippets to look at. Not docs, not a code dump.

## Goals

1. **Plain language first.** Lead with what it does and why it exists, in everyday words. No jargon or framework terms unless the reader asks.
2. **Follow the flow.** Trace the real path: input → what happens in between → output. Show the chain from entry point to result.
3. **Cite the code.** Always point at real snippets with file path and line numbers so the reader can open them and see for themselves.
4. **Explain the "why", not just the "what".** Call out the reasoning behind non-obvious choices and checks.
5. **Be honest.** If something is redundant, buggy, confusing, or double-verified, say so plainly instead of just agreeing.

## How to structure the answer

1. One-line summary: what it does and why it's useful.
2. Walk the flow in numbered steps, in the order the code actually runs.
3. For each step, show the exact snippet (path + line numbers) beside a plain-English description.
4. End with a "whole picture" recap when the flow spans many places.

## Reading order

1. Find the entry point(s) first — where it's triggered or wired up.
2. Follow the control flow through each function it calls.
3. Identify the data moving between steps — what's passed in, what comes out.
4. Note every branch and check, and explain what each one protects against.

## Citing snippets

Use code references with file path and line numbers:

```startLine:endLine:filepath
// the actual lines
```

Only include the lines that matter. Trim the rest with a `// ...` comment. Never dump a whole file.

## Distinguish things that look the same

When two things appear identical (two getters, two checks, two stores), explicitly explain the difference. This is where readers get most confused.

## Output style

- Simple sentences.
- No unexplained acronyms or framework terms.
- Use a table only when it genuinely clarifies (e.g. comparing two options side by side).
- Give your honest opinion when asked whether a pattern is good or bad — don't just say what the reader wants to hear.
