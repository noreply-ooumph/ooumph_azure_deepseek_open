# Azure AI Chat — Local Setup

## Requirements
Node.js v14+  — zero npm installs needed

## Setup

### Step 1 — Edit server.js (lines 8–10)
```js
const AZURE_BASE    = "https://ai-praveenmishraai8491456994967768.services.ai.azure.com";
const AZURE_API_KEY = "Fq04ZUOnjv0YpY39JUp9YZ922aZqTpc7glsIpbBl2Ki11ZIAmb0qJQQJ99CEACYeBjFXJ3w3AAAAACOGQ9Nb";
const API_VERSION   = "2024-05-01-preview";

const DEPLOYMENTS = [
  "DeepSeek-V4-Flash",
  "DeepSeek-V4-Flash-2",
  "DeepSeek-V4-Flash-3",
  "DeepSeek-V3-0324",
  "DeepSeek-V3.2",
  "Kimi-K2.6",
];
```

> ⚠ **Important:** Use `services.ai.azure.com` — not `openai.azure.com`.  
> Deployment names are **case-sensitive** — must match exactly as shown in Azure AI Foundry portal.

### Step 2 — Run
```bash
node server.js
```
Open → http://localhost:3000

---

## Features
- Switch between any deployed model from the sidebar dropdown
- Add extra deployment names live from the UI (no restart needed)
- Each chat session remembers which model was used
- Streaming responses
- Token counter

## File structure
```
deepseek-chat/
├── server.js    ← backend proxy + config
└── index.html   ← full UI (served automatically)
```

## Why `services.ai.azure.com` and not `openai.azure.com`

| Endpoint | Serves |
|---|---|
| `*.openai.azure.com` | Azure OpenAI models only (GPT-4, etc.) |
| `*.services.ai.azure.com` | Azure AI Foundry models (DeepSeek, Kimi, etc.) |

Azure AI Foundry inference path: `/models/chat/completions?api-version=...`  
Model name is passed in the **request body** as `model:`, not in the URL.