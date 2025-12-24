# Language

Summarize supports forcing the **output language** for summaries.

This affects the language of the generated summary text (not the extraction/transcription step).

## CLI

```bash
summarize --language de https://example.com
summarize --lang german https://example.com
```

## Config

`~/.summarize/config.json`:

```json
{
  "language": "en"
}
```

## Supported values

Best effort:

- Shorthand: `en`, `de`, `es`, `fr`, `pt-BR`, …
- Names: `english`, `german`/`deutsch`, `spanish`, …

Unknown strings are passed through to the model (sanitized). Example: `"language": "Swiss German"`.

