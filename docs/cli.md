---
summary: "CLI model providers and config for Claude, Codex, Gemini, and Cursor Agent."
read_when:
  - "When changing CLI model integration."
---

# CLI models

Summarize can use installed CLIs (Claude, Codex, Gemini, Cursor Agent) as local model backends.

## Model ids

- `cli/claude/<model>` (e.g. `cli/claude/sonnet`)
- `cli/codex/<model>` (e.g. `cli/codex/gpt-5.2`)
- `cli/gemini/<model>` (e.g. `cli/gemini/gemini-3-flash-preview`)
- `cli/agent/<model>` (e.g. `cli/agent/gpt-5.2`)

Use `--cli [provider]` (case-insensitive) for the provider default, or `--model cli/<provider>/<model>` to pin a model.
If `--cli` is provided without a provider, auto selection is used with CLI enabled.

## Auto mode

Auto mode can prepend CLI attempts in two ways:

- `cli.enabled` set in config:
  - Auto always uses this list order.
  - Also acts as an allowlist for explicit `--cli` / `--model cli/...`.
- Auto CLI fallback (`cli.autoFallback`, default enabled):
  - Applies only to **implicit** auto (when no model is set via flag/env/config).
  - Default behavior: only when no API key is configured.
  - Default order: `claude, gemini, codex, agent`.
  - Remembers + prioritizes the last successful CLI provider (`~/.summarize/cli-state.json`).

Gemini CLI performance: summarize sets `GEMINI_CLI_NO_RELAUNCH=true` for Gemini CLI runs to avoid a costly self-relaunch (can be overridden by setting it yourself).

Set explicit CLI allowlist:

```json
{
  "cli": { "enabled": ["gemini"] }
}
```

Configure auto CLI fallback:

```json
{
  "cli": {
    "autoFallback": {
      "enabled": true,
      "onlyWhenNoApiKeys": true,
      "order": ["claude", "gemini", "codex", "agent"]
    }
  }
}
```

Disable auto CLI fallback:

```json
{
  "cli": { "autoFallback": { "enabled": false } }
}
```

Note: `--model auto` (explicit) does not trigger auto CLI fallback unless `cli.enabled` is set.

## CLI discovery

Binary lookup:

- `CLAUDE_PATH`, `CODEX_PATH`, `GEMINI_PATH` (optional overrides)
- `AGENT_PATH` (optional override)
- Otherwise uses `PATH`

## Attachments (images/files)

When a CLI attempt is used for an image or non-text file, Summarize switches to a
path-based prompt and enables the required tool flags:

- Claude: `--tools Read --dangerously-skip-permissions`
- Gemini: `--yolo` and `--include-directories <dir>`
- Codex: `codex exec --output-last-message ...` and `-i <image>` for images
- Agent: uses built-in file tools in `agent --print` mode (no extra flags)

## Config

```json
{
  "cli": {
    "enabled": ["claude", "gemini", "codex", "agent"],
    "autoFallback": {
      "enabled": true,
      "onlyWhenNoApiKeys": true,
      "order": ["claude", "gemini", "codex", "agent"]
    },
    "codex": { "model": "gpt-5.2" },
    "gemini": { "model": "gemini-3-flash-preview", "extraArgs": ["--verbose"] },
    "claude": {
      "model": "sonnet",
      "binary": "/usr/local/bin/claude",
      "extraArgs": ["--verbose"]
    },
    "agent": {
      "model": "gpt-5.2",
      "binary": "/usr/local/bin/agent"
    }
  }
}
```

Notes:

- CLI output is treated as text only (no token accounting).
- If a CLI call fails, auto mode falls back to the next candidate.
- Cursor Agent CLI uses the `agent` binary and relies on Cursor CLI auth (login or `CURSOR_API_KEY`).
- Gemini CLI is invoked in headless mode with `--prompt` for compatibility with current Gemini CLI releases.

## Quick smoke test (all CLI providers)

Use a tiny local text file and run each provider with a longer timeout (Gemini can be slower):

```bash
printf "Summarize CLI smoke input.\nOne short paragraph. Reply can be brief.\n" >/tmp/summarize-cli-smoke.txt

summarize --cli codex --plain --timeout 2m /tmp/summarize-cli-smoke.txt
summarize --cli claude --plain --timeout 2m /tmp/summarize-cli-smoke.txt
summarize --cli gemini --plain --timeout 2m /tmp/summarize-cli-smoke.txt
summarize --cli agent --plain --timeout 2m /tmp/summarize-cli-smoke.txt
```

If Agent fails with auth, run `agent login` (interactive) or set `CURSOR_API_KEY`.

## Generate free preset (OpenRouter)

`summarize` ships with a built-in preset `free`, backed by OpenRouter `:free` models.
To regenerate the candidate list (and persist it in your config):

```bash
summarize refresh-free
```

Options:

- `--runs 2` (default): extra timing runs per selected model (total runs = 1 + runs)
- `--smart 3` (default): number of “smart-first” picks (rest filled by fastest)
- `--set-default`: also sets `"model": "free"` in `~/.summarize/config.json`
