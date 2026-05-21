# AGENTS.md — AI Daily Digest

Agent guidance for working in this repository.

---

## Repository Overview

Single-script TypeScript project that fetches RSS feeds from 90 curated tech blogs,
scores articles with AI, and generates a structured Markdown daily digest.

```
scripts/digest.ts   — sole source file (1287 lines, Bun runtime)
SKILL.md            — OpenCode skill definition for the /digest command
.github/workflows/digest.yml — scheduled GitHub Actions workflow (daily 08:00 UTC)
assets/             — static images for README
```

No build step. No test suite. No package.json (dependencies installed ad-hoc via `bun add` in CI).

---

## Runtime

- **Bun** is required. Use `npx -y bun` if Bun is not installed.
- The script is a single file with no local imports. All logic lives in `scripts/digest.ts`.
- Third-party dependencies (`nodemailer`) are imported at the top; they must be present
  before running locally (`bun add nodemailer`).

---

## Key Entry Points

| Symbol | Location | Purpose |
|---|---|---|
| `main()` | digest.ts ~L1250 | Top-level orchestrator |
| `callGemini()` | digest.ts ~L363 | Gemini API call (primary AI) |
| `callOpenAI()` | digest.ts ~L400 | OpenAI-compatible fallback |
| `scoreArticles()` | digest.ts | Batch scoring via AI |
| `summarizeArticles()` | digest.ts | Per-article summarisation |
| `generateReport()` | digest.ts | Markdown report assembly |
| `sendEmailWithAttachment()` | digest.ts ~L120 | Optional email delivery |
| `RSS_FEEDS` | digest.ts L22 | 90-entry feed list |

---

## Environment Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | Yes (primary) | — | Gemini 2.0 Flash |
| `OPENAI_API_KEY` | No (fallback) | — | OpenAI-compatible fallback |
| `OPENAI_API_BASE` | No | `https://api.openai.com/v1` | Custom endpoint (DeepSeek, etc.) |
| `OPENAI_MODEL` | No | `gpt-4o-mini` | Model name for fallback |
| `MAIL_SENDER_EMAIL` | No | — | Gmail sender address |
| `MAIL_SENDER_PASSWORD` | No | — | Gmail app password |
| `MAIL_RECIPIENT` | No | — | Digest email recipient |

Email sending is silently skipped when mail vars are absent.

---

## CLI Usage

```bash
bun scripts/digest.ts \
  --hours 48 \
  --top-n 15 \
  --lang zh \
  --output ./digest-$(date +%Y%m%d).md
```

| Flag | Values | Default |
|---|---|---|
| `--hours` | integer | 48 |
| `--top-n` | integer | 15 |
| `--lang` | `zh` \| `en` | `zh` |
| `--output` | file path | `./digest.md` |

---

## Skill (/digest command)

`SKILL.md` defines the interactive agent workflow triggered by `/digest` in OpenCode.
The skill guides the agent to:
1. Check `~/.hn-daily-digest/config.json` for saved preferences.
2. Collect parameters interactively (time range, article count, language, API key).
3. Execute `scripts/digest.ts` with the collected parameters.
4. Save config and display a Top 3 preview.

When modifying the script's CLI flags or config schema, update `SKILL.md` to match.

---

## Modifying the AI Provider

All AI logic is isolated in two functions (`callGemini`, `callOpenAI`) and one constant
(`GEMINI_API_URL`). Prompt strings are provider-agnostic. To swap providers:

1. Update `GEMINI_API_URL` (or add a new URL constant).
2. Rewrite the request body and response parsing in `callGemini` / add a new function.
3. Update env var references in the CLI help text and error messages.
4. Update `SKILL.md` and `README.md` accordingly.

---

## GitHub Actions Workflow

`.github/workflows/digest.yml` runs daily at 08:00 UTC and on `workflow_dispatch`.
Required secrets: `GEMINI_API_KEY`, `MAIL_SENDER_EMAIL`, `MAIL_SENDER_PASSWORD`, `MAIL_RECIPIENT`.
The generated digest is uploaded as an artifact (retained 30 days).

The workflow installs Playwright and Chromium — these are **not used** by `digest.ts`
itself and appear to be leftover from a previous version. Do not add Playwright
dependencies to the script without removing this note.

---

## Conventions

- **No tests.** Do not add a test framework without updating this file and the CI workflow.
- **No build step.** The script runs directly with Bun; do not introduce a compile step.
- **Single file.** Keep all logic in `scripts/digest.ts`. Do not split into modules
  without a clear reason and corresponding updates to `SKILL.md`.
- **Chinese-first.** Default output language is Chinese (`--lang zh`). English is
  supported but secondary. Keep Chinese comments in the script as-is.
- **Concurrency constants** (`FEED_CONCURRENCY = 3`, `MAX_CONCURRENT_GEMINI = 1`,
  `GEMINI_BATCH_SIZE = 10`) are tuned for free-tier API rate limits. Change with care.
