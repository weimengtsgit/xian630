# Context Limit 1M Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local Claude Code launchers `ccglm`, `ccvo`, and `ccvc` declare a 1,000,000-token context window and make the Claude Code statusline display context percentage against that 1M limit when token counts are available.

**Architecture:** Update the real launcher definitions in `/Users/mengwei/.zshrc` and the display script in `/Users/mengwei/.claude/statusline.sh`. The launchers set `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000`; the statusline script computes percentage from token-count fields with a safe fallback to Claude Code's existing `.context_window.used_percentage`.

**Tech Stack:** zsh shell functions, bash statusline script, `jq`, Claude Code statusline JSON.

## Global Constraints

- Do not edit shell snapshot files under `/Users/mengwei/.claude/shell-snapshots/`.
- Do not change provider base URLs, auth tokens, model names, effort settings, or unrelated environment variables.
- Use `1000000` as the 1M context-limit value.
- Keep `~/.claude/statusline.sh` compatible with current payloads by falling back to `.context_window.used_percentage`.
- Clamp displayed percentage to `0..100`.
- Verify with mock JSON payloads and shell syntax checks.

---

## File Structure

- Modify: `/Users/mengwei/.claude/statusline.sh`
  - Responsibility: Render the Claude Code statusline. It should extract model/cost as before, compute context percentage against 1M from token fields when possible, and render the same two-line output.
- Modify: `/Users/mengwei/.zshrc:179-243`
  - Responsibility: Define local Claude Code launcher functions. `ccglm`, `ccvo`, and `ccvc` should export `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000` before calling `__claude_launch`.

---

### Task 1: Update statusline 1M percentage calculation

**Files:**
- Modify: `/Users/mengwei/.claude/statusline.sh:1-37`

**Interfaces:**
- Consumes: Claude Code statusline JSON on stdin.
- Produces: Same two-line terminal output as before:
  - Line 1: colored progress bar, percent, model display name.
  - Line 2: total cost.

- [ ] **Step 1: Inspect the current script before editing**

Use the Read tool on `/Users/mengwei/.claude/statusline.sh` and confirm it currently computes `PCT` from `.context_window.used_percentage`.

Expected current relevant lines:

```bash
MODEL=$(echo "$input" | jq -r '.model.display_name // "unknown"')
PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)
COST=$(echo "$input" | jq -r '.cost.total_cost_usd // 0')
```

- [ ] **Step 2: Replace the script with the 1M-aware implementation**

Write this complete file to `/Users/mengwei/.claude/statusline.sh`:

```bash
#!/bin/bash
input=$(cat)

CONTEXT_LIMIT=1000000

# Extract data
MODEL=$(echo "$input" | jq -r '.model.display_name // "unknown"')
COST=$(echo "$input" | jq -r '.cost.total_cost_usd // 0')

USED_TOKENS=$(echo "$input" | jq -r '
  .context_window.used_tokens
  // .context_window.input_tokens
  // .context_window.current_tokens
  // .context_window.tokens_used
  // .usage.input_tokens
  // .usage.total_tokens
  // empty
')

if [[ "$USED_TOKENS" =~ ^[0-9]+$ ]]; then
  PCT=$((USED_TOKENS * 100 / CONTEXT_LIMIT))
else
  PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)
fi

if ! [[ "$PCT" =~ ^-?[0-9]+$ ]]; then
  PCT=0
fi
if [ "$PCT" -lt 0 ]; then
  PCT=0
elif [ "$PCT" -gt 100 ]; then
  PCT=100
fi

# Build progress bar
BAR_WIDTH=15
FILLED=$((PCT * BAR_WIDTH / 100))
EMPTY=$((BAR_WIDTH - FILLED))
BAR=""
if [ "$FILLED" -gt 0 ]; then
  printf -v FILL "%${FILLED}s"
  BAR="${FILL// /█}"
fi
if [ "$EMPTY" -gt 0 ]; then
  printf -v PAD "%${EMPTY}s"
  BAR="${BAR}${PAD// /░}"
fi

# Color based on usage
if [ "$PCT" -ge 80 ]; then
  COLOR="\033[31m"  # Red
elif [ "$PCT" -ge 60 ]; then
  COLOR="\033[33m"  # Yellow
else
  COLOR="\033[32m"  # Green
fi
RESET="\033[0m"

# Line 1: model + context bar
echo "${COLOR}${BAR}${RESET} ${PCT}% ${MODEL}"

# Line 2: cost
printf "💰 \$%.2f\n" "$COST"
```

- [ ] **Step 3: Run syntax check**

Run:

```bash
bash -n /Users/mengwei/.claude/statusline.sh
```

Expected: no output and exit code 0.

- [ ] **Step 4: Verify 200k used tokens displays 20%**

Run:

```bash
printf '%s\n' '{"model":{"display_name":"GLM 5.2"},"context_window":{"used_tokens":200000},"cost":{"total_cost_usd":1.23}}' | /Users/mengwei/.claude/statusline.sh
```

Expected output includes:

```text
20% GLM 5.2
💰 $1.23
```

- [ ] **Step 5: Verify 1M used tokens displays 100%**

Run:

```bash
printf '%s\n' '{"model":{"display_name":"GLM 5.2"},"context_window":{"used_tokens":1000000},"cost":{"total_cost_usd":0}}' | /Users/mengwei/.claude/statusline.sh
```

Expected output includes:

```text
100% GLM 5.2
💰 $0.00
```

- [ ] **Step 6: Verify fallback percentage displays 42%**

Run:

```bash
printf '%s\n' '{"model":{"display_name":"Fallback Model"},"context_window":{"used_percentage":42.8},"cost":{"total_cost_usd":0}}' | /Users/mengwei/.claude/statusline.sh
```

Expected output includes:

```text
42% Fallback Model
💰 $0.00
```

- [ ] **Step 7: Verify over-limit tokens clamp to 100%**

Run:

```bash
printf '%s\n' '{"model":{"display_name":"GLM 5.2"},"context_window":{"used_tokens":1200000},"cost":{"total_cost_usd":0}}' | /Users/mengwei/.claude/statusline.sh
```

Expected output includes:

```text
100% GLM 5.2
💰 $0.00
```

---

### Task 2: Add 1M context environment variable to local launchers

**Files:**
- Modify: `/Users/mengwei/.zshrc:200-243`

**Interfaces:**
- Consumes: zsh functions `ccglm`, `ccvo`, `ccvc` defined in `/Users/mengwei/.zshrc`.
- Produces: Each function exports `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000` before `__claude_launch "$@"`.

- [ ] **Step 1: Inspect the launcher definitions before editing**

Use the Read tool on `/Users/mengwei/.zshrc` around lines 179-243. Confirm:

```zsh
__unset_claude_vars() {
  unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL
  unset ANTHROPIC_DEFAULT_HAIKU_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_OPUS_MODEL
  unset CLAUDE_CODE_SUBAGENT_MODEL CLAUDE_CODE_EFFORT_LEVEL
  unset API_TIMEOUT_MS CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  unset CLAUDE_CODE_AUTO_COMPACT_WINDOW CLAUDE_CODE_MAX_CONTEXT_TOKENS DISABLE_COMPACT
}
```

This already unsets `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, so the implementation only needs to add exports inside `ccglm`, `ccvo`, and `ccvc`.

- [ ] **Step 2: Add context limit export to `ccglm`**

Edit `/Users/mengwei/.zshrc` in `ccglm()` so this block:

```zsh
  export CLAUDE_CODE_SUBAGENT_MODEL=glm-5.1
  export CLAUDE_CODE_EFFORT_LEVEL=max
  __claude_launch "$@"
```

becomes:

```zsh
  export CLAUDE_CODE_SUBAGENT_MODEL=glm-5.1
  export CLAUDE_CODE_EFFORT_LEVEL=max
  export CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000
  __claude_launch "$@"
```

- [ ] **Step 3: Add context limit export to `ccvo`**

Edit `/Users/mengwei/.zshrc` in `ccvo()` so this block:

```zsh
  export ANTHROPIC_AUTH_TOKEN=ark-18a2306c-81fa-48c8-9437-785158508922-82ed1
  export ANTHROPIC_MODEL=ark-code-latest
  __claude_launch "$@"
```

becomes:

```zsh
  export ANTHROPIC_AUTH_TOKEN=ark-18a2306c-81fa-48c8-9437-785158508922-82ed1
  export ANTHROPIC_MODEL=ark-code-latest
  export CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000
  __claude_launch "$@"
```

- [ ] **Step 4: Add context limit export to `ccvc`**

Edit `/Users/mengwei/.zshrc` in `ccvc()` so this block:

```zsh
  export ANTHROPIC_AUTH_TOKEN=ark-1af3525b-c953-4859-ab87-b98d393416df-3dcd2
  export ANTHROPIC_MODEL=ark-code-latest
  __claude_launch "$@"
```

becomes:

```zsh
  export ANTHROPIC_AUTH_TOKEN=ark-1af3525b-c953-4859-ab87-b98d393416df-3dcd2
  export ANTHROPIC_MODEL=ark-code-latest
  export CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000
  __claude_launch "$@"
```

- [ ] **Step 5: Run zsh syntax check**

Run:

```bash
zsh -n /Users/mengwei/.zshrc
```

Expected: no output and exit code 0.

- [ ] **Step 6: Verify each function exports the context limit**

Run:

```bash
zsh -lc 'source /Users/mengwei/.zshrc >/dev/null 2>&1; typeset -f ccglm ccvo ccvc | grep -n "CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000"'
```

Expected: three matching lines, one for each function.

---

### Task 3: Final verification and reporting

**Files:**
- No new modifications expected beyond Task 1 and Task 2.

**Interfaces:**
- Consumes: Updated `/Users/mengwei/.claude/statusline.sh` and `/Users/mengwei/.zshrc`.
- Produces: Verified local configuration and a concise summary for the user.

- [ ] **Step 1: Confirm shell snapshots were not modified**

Run:

```bash
find /Users/mengwei/.claude/shell-snapshots -type f -newer /Users/mengwei/ww/Developer/xian630/docs/superpowers/specs/2026-06-25-context-limit-1m-design.md -print
```

Expected: no output from files edited for this task. If output appears, inspect timestamps before claiming snapshots changed; this command is only a guardrail because Claude Code may create snapshots during normal use.

- [ ] **Step 2: Check project git status**

Run:

```bash
git -C /Users/mengwei/ww/Developer/xian630 status --short
```

Expected: only the new spec and plan files are shown inside the project. `/Users/mengwei/.claude/statusline.sh` and `/Users/mengwei/.zshrc` are outside this git repo and will not appear.

- [ ] **Step 3: Summarize exact changed files**

Report these files to the user:

```text
Modified global files:
- /Users/mengwei/.claude/statusline.sh
- /Users/mengwei/.zshrc

Project docs added:
- docs/superpowers/specs/2026-06-25-context-limit-1m-design.md
- docs/superpowers/plans/2026-06-25-context-limit-1m.md
```

- [ ] **Step 4: Tell the user how to activate launcher changes**

Tell the user:

```text
Open a new terminal, or run `source ~/.zshrc`, then start Claude Code with `ccglm`, `ccvo`, or `ccvc`.
```

## Self-Review

- Spec coverage: The plan covers statusline computation, launcher exports, fallback behavior, clamping, no snapshot edits, and verification commands.
- Placeholder scan: No TBD/TODO/fill-in steps remain. Every code change has concrete replacement text.
- Type/name consistency: The only new interface is `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000`, used consistently in all launcher steps.
