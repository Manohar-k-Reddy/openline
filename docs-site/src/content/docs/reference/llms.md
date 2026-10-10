---
title: For AI agents (llms.txt)
description: Machine-readable versions of these docs for coding assistants and AI agents.
---

These docs are also published in formats made for language models, following the
[llms.txt](https://llmstxt.org) convention:

| File | Contents |
|---|---|
| [`/llms.txt`](../../llms.txt) | Short overview and an index of the documentation sets. |
| [`/llms-full.txt`](../../llms-full.txt) | All documentation in one Markdown file. |
| [`/llms-small.txt`](../../llms-small.txt) | A trimmed version for small context windows. |
| [`/openapi.yaml`](../../openapi.yaml) | The API as an OpenAPI 3.1 spec. |

## Using them

- **Coding assistants (Claude Code, Cursor, Copilot):** paste the `llms-full.txt` URL, or add it
  as a documentation source, before asking for an integration.
- **Agents that call the API:** give them `openapi.yaml` as their tool definition; most agent
  frameworks can turn an OpenAPI spec into tools.
- **Client libraries:** generate one from `openapi.yaml` with any OpenAPI generator.

A good prompt to start with:

> Read https://manohar1404.github.io/openline/llms-full.txt. Using the OpenLine API, write a
> FastAPI service that places a call with `stream` pointing at a Pipecat bot, and handles the
> `call.disconnected` webhook.
