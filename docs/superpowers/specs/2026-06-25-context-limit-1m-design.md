# Context Usage Display 1M Limit Design

Date: 2026-06-25

## Goal

Update the local Claude Code CLI context usage display for `ccglm`, `ccvo`, and `ccvc` so the visible percentage reflects a 1,000,000-token context window instead of the current approximately 200,000-token basis.

The change targets local tooling only. It should not change model routing, API credentials, or project application behavior.

## Scope

In scope:

- Update the Claude Code statusline script at `~/.claude/statusline.sh` to calculate context percentage against a 1M token limit when token counts are available.
- Update the real shell configuration that defines `ccglm`, `ccvo`, and `ccvc` so each launcher exports a 1M context-limit environment setting.
- Preserve fallback behavior when Claude Code does not provide token-count fields to the statusline script.
- Verify the statusline output with mock JSON inputs.

Out of scope:

- Modifying Claude Code itself.
- Modifying generated shell snapshot files.
- Changing provider base URLs, auth tokens, model names, or effort settings.
- Changing `cc-status`; it records lifecycle status and subagent token totals but does not render the Claude Code context percentage.

## Architecture

The implementation has two layers.

### Launch-time configuration

The shell functions `ccglm`, `ccvo`, and `ccvc` will export a 1M context limit before invoking Claude Code. The intended environment variable is:

```sh
export CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000
```

If the existing launcher already exports context-related variables, the implementation will update the existing value rather than adding a duplicate. The real shell configuration file must be located before editing; shell snapshot files under `~/.claude/shell-snapshots/` are read-only evidence and must not be edited.

### Statusline display calculation

`~/.claude/statusline.sh` currently reads `.context_window.used_percentage` directly. That value can be incorrect when the local provider supports 1M context but Claude Code reports percentage using a smaller default.

The script will instead:

1. Read the statusline JSON from stdin once.
2. Extract model display name and total cost as today.
3. Try to extract context used tokens from known statusline fields.
4. If used tokens are present and numeric, compute:

   ```text
   percent = floor(used_tokens * 100 / 1000000)
   ```

5. Clamp the result to `0..100`.
6. If used tokens are unavailable, fall back to `.context_window.used_percentage` and clamp that value.

This keeps the display useful across Claude Code versions and provider adapters.

## Data Flow

1. User runs `ccglm`, `ccvo`, or `ccvc`.
2. The shell function exports provider-specific settings plus `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000`.
3. Claude Code invokes the configured statusline command with a JSON payload.
4. `statusline.sh` computes the progress percentage against 1M if it can read used-token data.
5. The script renders the existing progress bar and cost line.

## Token Field Strategy

The implementation should be defensive because Claude Code statusline payload shapes can change. It should check likely fields such as:

- `.context_window.used_tokens`
- `.context_window.input_tokens`
- `.context_window.current_tokens`
- `.transcript.usage.input_tokens` or similar usage totals if present

Only numeric, positive values should be used for the 1M calculation. If none are found, use the existing `.context_window.used_percentage` behavior.

Before finalizing the exact field list, inspect a real or representative statusline payload if available. If no real payload is available, implement the field extraction as a safe ordered fallback and verify with mocked payloads.

## Error Handling

- Missing `jq` or invalid JSON: keep behavior simple and fail visibly rather than silently printing misleading usage. The existing script already depends on `jq`.
- Missing token fields: fall back to `.context_window.used_percentage`.
- Non-numeric fields: ignore them and continue to fallback.
- Computed percentage below 0: display 0%.
- Computed percentage above 100: display 100%.
- Missing shell function definition file: stop and report what was found instead of editing snapshots.

## Testing

Run shell-level checks:

- Syntax check `~/.claude/statusline.sh` with `bash -n`.
- Feed mock JSON with `context_window.used_tokens = 200000`; expected display includes `20%`.
- Feed mock JSON with `context_window.used_tokens = 1000000`; expected display includes `100%`.
- Feed mock JSON without used-token fields but with `context_window.used_percentage = 42`; expected display includes `42%`.
- Feed mock JSON with `context_window.used_tokens = 1200000`; expected display clamps to `100%`.

Verify launcher configuration:

- Locate the real shell configuration file containing `ccglm`, `ccvo`, and `ccvc`.
- Confirm each function exports `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000` before launching Claude Code.
- Do not edit or rely on `~/.claude/shell-snapshots/` files.

## Rollback

Rollback is straightforward:

- Restore the previous `~/.claude/statusline.sh` calculation using `.context_window.used_percentage` directly.
- Remove `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000` from the three launcher functions.

No database migrations or project state changes are involved.
