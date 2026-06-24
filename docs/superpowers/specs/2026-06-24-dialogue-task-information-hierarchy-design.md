# Dialogue Task Information Hierarchy

## Goal

Remove duplicate application names from the selected dialogue's task panel while
preserving a clear distinction between the application being discussed and the
action currently running for it.

## Scope

- The Conversation Workbench header displays the selected dialogue's resolved
  application name when one exists.
- Before an application is resolved, the header continues to display the
  dialogue requirement summary (or `新会话`).
- The Current Task title displays an action-oriented job description and must
  not fall back to `job.app_name`.
- The existing history list, task status, queue time, actual start time,
  progress, task controls, and backend contracts remain unchanged.

## Data and Rendering Rules

1. Header title priority: `view.resolvedApplication.name`, then its slug, then
   the existing dialogue title fallback.
2. Task title priority: normalized prompt, user prompt, generic task title,
   job id, then `未命名任务`. `app_name` is deliberately excluded.
3. The title rule applies only to the selected dialogue's focus task. It does
   not change scheduler selection or cross-session task isolation.

## Validation

- Add a logic check proving the header reads the resolved application and the
  task-title selector excludes `app_name`.
- Run `npm run test:logic` and `npm run build`.
