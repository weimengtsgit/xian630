import { X } from 'lucide-react'
import { AgentsPanel } from './AgentsPanel'
import { JobCenter } from './JobCenter'
import './WorkbenchDrawer.css'

// WorkbenchDrawer is the unified right-side 工作台抽屉 host (Phase 1 of the
// workbench-drawer migration). It is a single overlay that renders content for
// the active entry chosen by the 3 top-right workbench header buttons
// (任务执行 / 协作智能体 / 应用项目).
//
// The three entries are mutually exclusive: the active one is passed in as
// `activeEntry`; passing null closes the drawer. The host itself is a presentational
// overlay (position:absolute on the right of the workbench, slides in) so the
// center column's width never jitters when the drawer opens/closes.
//
// Phase 2 entries:
//   - 'task'       (任务执行): renders the selected dialogue's generation tasks
//                   via <JobCenter/> — a task list (ALL dialogue tasks, focus task
//                   first) that drills into each task's vertical 执行波次 + agent
//                   cards, with the step detail opening IN THE SAME drawer
//                   (embedded, no portal overlay). When the dialogue has no
//                   generation task, JobCenter shows the "当前会话暂无生成任务"
//                   empty state.
//   - 'agents'     (协作智能体): renders the existing AgentsPanel CONTENT (agents
//                   list + create/delete/detail) by reusing AgentsPanel without its
//                   hide button (no onHidePanel prop => the button stays hidden).
//   - 'application' (应用项目): disabled upstream when no application is bound; when
//                   forced open renders a placeholder (Phase 5 fills the project tree).
export function WorkbenchDrawer({
  activeEntry,
  onClose,
  agentsProps,
  focusTaskActive,
  // Phase 2: task-observability props threaded from App (useJobs + focusTask).
  // `taskProps.jobs` is the ranked dialogue task list (ALL tasks, focus first);
  // `taskProps.activeJob` is the selected task (focus by default); the rest are
  // the accessors JobCenter needs (steps, summary, collaborationPlan, records/
  // artifacts accessors, cancel/retry/repair-from-failure, snapshot save).
  taskProps,
}) {
  if (!activeEntry) return null
  const title = ENTRY_TITLES[activeEntry] || ''
  return (
    <aside className={`workbench-drawer workbench-drawer-open`} role="dialog" aria-label={title}>
      <header className="workbench-drawer-header">
        <strong>{title}</strong>
        <button
          type="button"
          className="workbench-drawer-close"
          onClick={onClose}
          title="关闭"
          aria-label="关闭"
        >
          <X size={16} />
        </button>
      </header>

      <div className="workbench-drawer-body">
        {activeEntry === 'task' ? (
          <JobCenter {...(taskProps || {})} />
        ) : null}
        {activeEntry === 'agents' ? (
          <AgentsPanel
            {...(agentsProps || {})}
            // AgentsPanel renders its hide button only when onHidePanel is passed,
            // so omitting it keeps the drawer-hosted list free of the old column
            // hide affordance.
          />
        ) : null}
        {activeEntry === 'application' ? <ApplicationProjectPlaceholder /> : null}
      </div>
    </aside>
  )
}

const ENTRY_TITLES = {
  task: '任务执行',
  agents: '协作智能体',
  application: '应用项目',
}

function ApplicationProjectPlaceholder() {
  return (
    <div className="workbench-drawer-placeholder">
      <p>当前应用暂无可浏览的项目文件。</p>
      <small>生成完成后可在此查看项目文档、代码与配置（Phase 5 迁入）。</small>
    </div>
  )
}
