# LLM / summarization mode

By default `summarize` will call an LLM using **direct provider API keys**.

## Defaults

- Default model: `xai/grok-4-fast-non-reasoning`
- Override with `SUMMARIZE_MODEL`, config file (`model`), or `--model`.

## Env

- `XAI_API_KEY` (required for `xai/...` models)
- `OPENAI_API_KEY` (required for `openai/...` models)
- `GOOGLE_GENERATIVE_AI_API_KEY` (required for `google/...` models)
- `ANTHROPIC_API_KEY` (required for `anthropic/...` models)
- `SUMMARIZE_MODEL` (optional; overrides default model selection)
- `SUMMARIZE_CONFIG` (optional; path to a JSON config file)

## Flags

- `--model <model>`
  - Examples:
    - `xai/grok-4-fast-non-reasoning`
    - `openai/gpt-5.2`
    - `google/gemini-2.0-flash`
    - `anthropic/claude-sonnet-4-5`
- `--length short|medium|long|xl|xxl|<chars>`
  - This is *soft guidance* to the model (no hard truncation).
- `--json` (includes prompt + summary in one JSON object)
