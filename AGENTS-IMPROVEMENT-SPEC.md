# AGENTS-IMPROVEMENT-SPEC.md

Audit of existing agent guidance files and concrete improvements to make.

---

## What Was Found

| File | Role |
|---|---|
| `AGENTS.md` | Did not exist — created as part of this audit |
| `SKILL.md` | OpenCode skill definition for `/digest` |
| `README.md` | User-facing documentation (Chinese) |
| `.devcontainer/devcontainer.json` | Dev container config |
| `.github/workflows/digest.yml` | CI/CD workflow |

No `.ona/skills/`, `.cursor/rules/`, or other agent rule files were present.

---

## Assessment

### What's Good

- **`SKILL.md` is detailed and well-structured.** It covers the full interactive flow,
  parameter mapping, config persistence, and troubleshooting. An agent following it
  cold would succeed.
- **`README.md` is thorough.** Pipeline steps, output structure, category taxonomy,
  and provider-swap instructions are all documented.
- **Single-file architecture is agent-friendly.** There is exactly one script to read
  and modify. No module graph to trace.
- **Prompt for provider swap is included in README.** This is a good pattern — it
  gives agents a ready-made instruction set for a common customisation task.

### What's Missing

1. **No `AGENTS.md`.** There was no file telling agents where things are, what the
   runtime is, what the key functions are, or what conventions to follow. Created now.

2. **No function-level map in any agent file.** `SKILL.md` references `SKILL_DIR` but
   never names the internal functions an agent would need to touch when modifying
   behaviour (scoring logic, report generation, etc.).

3. **No local run instructions for agents.** `SKILL.md` assumes the agent is running
   inside OpenCode. There are no instructions for running the script directly in a
   dev environment, which matters when an agent is asked to debug or extend the script.

4. **Playwright/Chromium in CI is unexplained.** The workflow installs Playwright and
   Chromium but `digest.ts` does not use them. No comment explains why. An agent
   editing the workflow would not know whether to keep or remove these steps.

5. **No `bun.lockb` or `package.json`.** Dependencies (`nodemailer`) are installed
   ad-hoc in CI with `bun add`. There is no lockfile. An agent cannot know the
   expected version of `nodemailer` or whether other packages were previously used.

6. **Config schema is defined only in `SKILL.md`, not in the script.** The
   `~/.hn-daily-digest/config.json` schema is documented in `SKILL.md` but the script
   reads/writes it independently. If the schema drifts, agents have no single source
   of truth.

7. **No description of the scoring algorithm.** The AI scoring prompt is embedded in
   the script but not summarised anywhere. An agent asked to "adjust scoring criteria"
   has to read ~1300 lines to find the relevant prompt strings.

8. **`SKILL.md` uses pseudo-code `question()` calls** that do not correspond to any
   real API. An agent unfamiliar with OpenCode's tool set might try to call these
   literally. The file should clarify these are illustrative, not executable.

### What's Wrong

1. **`SKILL.md` Step 1b asks for Gemini API Key via `question()` with `options: []`.**
   An empty options array is not a valid question pattern. This will confuse agents
   that try to render it as a choice list.

2. **`SKILL.md` Step 2 hardcodes `OPENAI_API_BASE` to DeepSeek** in the example
   command, even though the user may not be using DeepSeek. This could cause agents
   to export a wrong base URL silently.

3. **`SKILL.md` says `FEED_CONCURRENCY = 10`** in the description section, but the
   script constant is `FEED_CONCURRENCY = 3`. The README also says "10 路并发". This
   is a stale value that will mislead agents reasoning about rate limits or timeouts.

4. **`devcontainer.json` uses a 10 GB universal image** with no justification. An
   agent asked to optimise the dev container would not know whether the size is
   intentional. The file has a comment suggesting smaller images but no explanation
   of why the universal image was chosen.

5. **`.gitignore` does not exclude `digest-*.md` output files.** The CI workflow
   generates `digest-YYYYMMDD.md` in the repo root. If an agent runs the script
   locally, the output file will appear as an untracked file and may be accidentally
   committed.

---

## Improvement Spec

### P0 — Correctness fixes (do these first)

#### 1. Fix `FEED_CONCURRENCY` documentation mismatch

**File:** `SKILL.md` and `README.md`

The script sets `FEED_CONCURRENCY = 3`. Both `SKILL.md` (implicitly, via the
description) and `README.md` ("10 路并发") state 10. Update README.md to say
"3 路并发" (or whatever the current constant value is). Add a comment in the script
next to the constant explaining the rate-limit rationale so future changes stay in sync.

#### 2. Fix `SKILL.md` Step 1b empty options

**File:** `SKILL.md`

Replace the `options: []` pattern in Step 1b with a plain text prompt instruction,
e.g.:

```
Ask the user to paste their Gemini API Key as a free-text response.
Obtain it from: https://aistudio.google.com/apikey
```

#### 3. Fix `SKILL.md` Step 2 hardcoded DeepSeek base URL

**File:** `SKILL.md`

The example command exports `OPENAI_API_BASE=https://api.deepseek.com/v1` and
`OPENAI_MODEL=deepseek-chat` unconditionally. Change to only export these if the
user has explicitly provided a custom base URL. Add a conditional note:

```
# Only set if user provided a custom OpenAI-compatible endpoint:
export OPENAI_API_BASE="<user-provided-base-url>"
export OPENAI_MODEL="<user-provided-model>"
```

#### 4. Add `digest-*.md` to `.gitignore`

**File:** `.gitignore`

Add:
```
digest-*.md
output/
```

This prevents locally generated digests from being accidentally committed.

---

### P1 — Agent usability improvements

#### 5. Add scoring prompt summary to `AGENTS.md`

**File:** `AGENTS.md`

Add a section describing the two AI prompt templates (scoring and summarisation),
their inputs, outputs, and where they live in the script. Example:

```
## AI Prompts

Two prompt templates are embedded in digest.ts:

| Prompt | Function | Input | Output |
|---|---|---|---|
| Scoring | scoreArticles() | Article title + description | JSON: {score, category, keywords} |
| Summarisation | summarizeArticles() | Article title + content | JSON: {summary, chineseTitle, reason} |

Both prompts are locale-aware (--lang flag). To adjust scoring criteria, edit the
prompt string inside scoreArticles(). To change summary format, edit summarizeArticles().
```

#### 6. Clarify `question()` pseudo-code in `SKILL.md`

**File:** `SKILL.md`

Add a note at the top of the "交互流程" section:

```
> Note: `question()` blocks below are illustrative. Use your agent tool's
> native question/clarification mechanism (e.g., ask_clarifying_questions in Ona,
> or plain conversational prompts in other tools).
```

#### 7. Add local development instructions to `AGENTS.md`

**File:** `AGENTS.md`

Add a "Local Development" section:

```
## Local Development

# Install runtime dependency
bun add nodemailer

# Run with a test output
export GEMINI_API_KEY="..."
bun scripts/digest.ts --hours 24 --top-n 5 --lang en --output /tmp/test-digest.md

# Inspect output
cat /tmp/test-digest.md
```

#### 8. Explain Playwright in CI workflow

**File:** `.github/workflows/digest.yml`

Add a comment above the Playwright install step explaining its purpose, or remove it
if it is genuinely unused. If it was used for screenshot-based email rendering and
was removed, delete the install steps to reduce CI time (~2 min savings).

---

### P2 — Structural improvements (lower priority)

#### 9. Add `package.json` with pinned `nodemailer`

**File:** `package.json` (new)

Create a minimal `package.json` so dependency versions are explicit and reproducible:

```json
{
  "name": "ai-daily-digest",
  "private": true,
  "dependencies": {
    "nodemailer": "^6.9.0"
  }
}
```

Run `bun install` to generate `bun.lockb`. Update CI to use `bun install` instead of
`bun add nodemailer`.

#### 10. Add config schema as a TypeScript type in the script

**File:** `scripts/digest.ts`

Define the config type explicitly so it is the single source of truth:

```typescript
type DigestConfig = {
  geminiApiKey: string;
  timeRange: number;   // hours
  topN: number;
  language: 'zh' | 'en';
  lastUsed: string;    // ISO 8601
};
```

Reference this type in `AGENTS.md` and `SKILL.md` instead of duplicating the schema.

#### 11. Optimise `devcontainer.json`

**File:** `.devcontainer/devcontainer.json`

Replace the 10 GB universal image with a Node.js image and install Bun as a feature:

```json
{
  "name": "ai-daily-digest",
  "image": "mcr.microsoft.com/devcontainers/javascript-node:22",
  "features": {
    "ghcr.io/shyim/devcontainers-features/bun:0": {}
  }
}
```

This reduces image size significantly and makes the runtime explicit. Only do this
if the universal image is not needed for other tooling.

---

## Priority Order

| # | Item | Priority | Effort |
|---|---|---|---|
| 1 | Fix FEED_CONCURRENCY docs mismatch | P0 | 5 min |
| 2 | Fix SKILL.md empty options | P0 | 5 min |
| 3 | Fix SKILL.md hardcoded DeepSeek URL | P0 | 5 min |
| 4 | Add digest-*.md to .gitignore | P0 | 2 min |
| 5 | Add scoring prompt summary to AGENTS.md | P1 | 15 min |
| 6 | Clarify question() pseudo-code | P1 | 5 min |
| 7 | Add local dev instructions to AGENTS.md | P1 | 10 min |
| 8 | Explain/remove Playwright in CI | P1 | 10 min |
| 9 | Add package.json + lockfile | P2 | 20 min |
| 10 | Add DigestConfig type to script | P2 | 15 min |
| 11 | Optimise devcontainer image | P2 | 20 min |
