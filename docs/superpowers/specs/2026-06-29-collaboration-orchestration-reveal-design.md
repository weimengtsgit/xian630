# Collaboration Orchestration Reveal Design

## Goal

Improve the conversation-area `协作编排执行图` so it communicates that the
`协作编排`智能体 is actively selecting and arranging the required collaboration
agents. The graph should feel like the orchestrator has reasoned about the user
request and then summoned the needed agents into the execution plan.

This design applies only to the dialogue graph surface in `sf-portal-mvp`. It
does not change backend orchestration, job execution, or the task drawer data
model.

## Decisions

- Use a hybrid interaction model.
- Before the user clicks `确认并生成`, play a one-time reveal animation whenever
  the graph is opened or rendered.
- After the reveal finishes, keep all planned cards visible in the same layout.
- After `确认并生成`, keep the graph structure stable, replay the same one-time
  reveal animation, and use real task execution data for card and edge states.
- Before confirmation, cards may hover and highlight related dependencies but
  must not open task details because real task steps do not exist yet.
- After confirmation, cards with `stepId` may open the task drawer and select the
  matching step attempt.

## User Experience

### Pre-confirmation Reveal

The graph initially shows:

- `用户输入`
- `协作编排`

The `协作编排` card enters an active orchestration state:

- subtle pulse or scan effect on the card
- label copy such as `编排中`
- outgoing flow line begins from the orchestrator side

Agent cards after the orchestrator are revealed one by one in deterministic
graph order:

1. lower wave index first
2. within the same wave, existing card order
3. dependencies and connectors reveal with, or just before, the target card

Each revealed agent lands in `待确认` state. When all planned cards are visible,
the graph remains fully expanded and stops the reveal motion.

### Post-confirmation Execution View

Once real task steps are present, the graph replays the same one-time reveal
animation so the accepted execution graph still feels summoned by the
orchestrator. The layout stays stable after the reveal completes, while card and
edge states reflect execution:

- completed cards show `已完成`
- running cards show `执行中`
- pending cards with unfinished upstream show `等待上游`
- ready cards show `待启动`
- failed cards show `失败`
- edges switch between `completed`, `flowing`, `inactive`, and `blocked`

This avoids adding a second graph or appending per-agent long task cards below
the graph.

## Component Design

The implementation should extend `CollaborationExecutionGraph.jsx` rather than
creating a second graph component.

Current implementation note:

- `STATE_ICON.failed` must have a valid `AlertTriangle` import before this work
  is implemented; otherwise a failed card can hit a runtime reference error.

Recommended component responsibilities:

- `CollaborationExecutionGraph`
  - owns reveal state for the currently rendered graph instance
  - decides whether reveal mode is active from `graph.confirmed`
  - computes visible cards and visible edges for rendering
  - resets and replays reveal when an unconfirmed graph instance is mounted
- `GraphCard`
  - receives visibility/reveal class flags
  - keeps existing hover and click rules
- `WaveConnector`
  - receives visible edge list
  - keeps segmented connector rendering
  - does not render edges whose target card has not been revealed

The reveal state can be local React state:

- `revealedKeys: Set<string>`
- `revealComplete: boolean`

For confirmed graphs:

- initialize visible keys to `用户输入` and `协作编排`
- schedule subsequent cards with the same reveal timing
- use real task state labels while each card is revealed
- finish with all cards visible and no active orchestration pulse

For unconfirmed graphs:

- initialize visible keys to `用户输入` and `协作编排`
- schedule subsequent cards with a small fixed interval
- clear timers on unmount or graph identity change

## Timing

Suggested defaults:

- initial orchestrator delay: 250 ms
- per-card reveal interval: 180-240 ms
- max stagger should stay short enough that a 13-agent plan finishes in roughly
  3 seconds

The reveal should respect `prefers-reduced-motion`:

- if reduced motion is enabled, show all cards immediately
- still apply static status styling

## Graph Identity

The reveal should reset only when the logical preview changes. A practical graph
identity can be derived from:

- `graph.confirmed`
- ordered card keys
- edge ids

Avoid resetting the animation for unrelated parent re-renders.

## Interaction Rules

Before confirmation:

- cards remain focusable and hoverable
- cards without `stepId` do not open the task drawer
- tooltip/title remains `确认后可打开任务详情`
- related-card dimming still works for visible cards

After confirmation:

- cards with `stepId` call `onOpenTask(card)`
- cards without `stepId` remain non-opening but hoverable
- state copy comes from real task state, not the reveal animation

## Styling

Add CSS classes rather than inline animation logic:

- `.ceg-is-orchestrating`
- `.ceg-card-is-hidden`
- `.ceg-card-is-revealing`
- `.ceg-card-is-revealed`
- `.ceg-edge-is-revealing`

The orchestrator should have an active pulse only in pre-confirmation reveal
mode and post-confirmation replay mode. The pulse should be visible enough to
read as orchestration work, and may include a scan/sweep layer in addition to a
border pulse. The existing segmented line style should remain aligned with
`sf-portal/src/components/AgentsPanel.css`.

## Testing

Update `scripts/check-collaboration-plan.mjs` to assert:

- the graph component has reveal state or reveal helper logic
- unconfirmed graph rendering supports hidden/revealing card classes
- confirmed graph rendering replays reveal once while showing execution state
- task blocks are still suppressed when the collaboration graph is present

Manual/browser smoke should verify:

- unconfirmed graph starts with only user input and orchestrator visible
- agents appear one by one and then remain visible
- after confirmation, reveal replays once, then layout stays stable
- hover remains available before confirmation
- task drawer navigation still works after confirmation

## Non-goals

- Do not add backend orchestration events for this iteration.
- Do not persist per-user reveal completion.
- Do not add a second execution graph below the preview graph.
- Do not reintroduce per-agent long task cards in the dialogue.
- Do not change task execution ordering or agent selection logic.
