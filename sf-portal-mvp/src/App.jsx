import { useCallback, useEffect, useMemo, useState } from 'react'
import { TopBar } from './components/TopBar'
import { LeftToolbar } from './components/LeftToolbar'
import { SessionNav } from './components/SessionNav'
import { ConversationWorkbench } from './components/ConversationWorkbench'
import { WorkbenchDrawer } from './components/WorkbenchDrawer'
import { useApplications } from './hooks/useApplications'
import { useManagedAgents } from './hooks/useManagedAgents'
import { useAgents } from './hooks/useAgents'
import { useJobs } from './hooks/useJobs'
import { useDialogueSessions } from './hooks/useDialogueSessions'
import { rankTasks } from './hooks/focusTask'
import { factoryApi } from './api/client'
import './App.css'

// Stable wrapper so JobCenter (Phase 2) can lazily load a selected artifact's TEXT
// content (never eagerly fetched). Kept for Phase 2's 任务执行 drawer wiring.
const factoryApiGetArtifactContent = id => factoryApi.getArtifactContent(id)
// Exposed so the new check script can assert the Phase 1 surface stays wired even
// though the call site moves in Phase 2.
export { factoryApiGetArtifactContent }

// The three mutually-exclusive workbench-drawer entries, keyed by the header
// button that opens them. null means the drawer is closed.
const DRAWER_ENTRIES = ['task', 'agents', 'application']

function App() {
  const apps = useApplications()
  const managedAgents = useManagedAgents()
  const agents = useAgents()
  const jobs = useJobs()
  const dialogue = useDialogueSessions()
  // Phase 1 layout: the left nav owns its OWN collapse (no rail toggle), and the
  // right drawer is an overlay opened by the 3 workbench header buttons.
  const [sessionNavCollapsed, setSessionNavCollapsed] = useState(false)
  const [drawerEntry, setDrawerEntry] = useState(null)
  const workbenchClass = [
    'workbench',
    sessionNavCollapsed ? 'session-nav-collapsed' : '',
  ].filter(Boolean).join(' ')

  // Feed the live job list into the dialogue hook so it can select a dialogue-
  // scoped focus task (Constraint #10). The hook filters by dialogue_id
  // server-side; passing the full list is cheap and stays in sync on every
  // job.created/updated SSE.
  useEffect(() => {
    dialogue.setJobsForFocus(jobs.jobs)
  }, [jobs.jobs, dialogue.setJobsForFocus])

  // The 任务执行 drawer shows ALL generation tasks for the selected dialogue,
  // defaulting to the focus task (plan §Task Execution Drawer). The drawer's
  // task list is the dialogue's jobs ranked by attention priority (focus task
  // first); `selectedTaskId` lets the user drill into a non-focus task. null
  // means "follow the focus task" — the default on dialogue switch.
  const dialogueJobs = useMemo(
    () => rankTasks(jobs.jobs, dialogue.selectedDialogueId),
    [jobs.jobs, dialogue.selectedDialogueId],
  )
  const [selectedTaskId, setSelectedTaskId] = useState(null)
  const effectiveTaskId = selectedTaskId || (dialogue.focusTask && dialogue.focusTask.id) || null
  const activeJob =
    dialogueJobs.find(j => j.id === effectiveTaskId) || dialogue.focusTask || null
  const onSelectTask = useCallback(id => setSelectedTaskId(id || null), [])

  // A session switch is also a task-context switch. Re-follow the new dialogue's
  // focus task (clear any manual selection from the previous session) and
  // hydrate its details.
  useEffect(() => {
    setSelectedTaskId(null)
  }, [dialogue.selectedDialogueId])

  // If the manually-selected task leaves the dialogue's job list (deleted, or
  // rotated out by a later list snapshot), fall back to the focus task so the
  // drawer never pins a stale id.
  useEffect(() => {
    if (selectedTaskId && !dialogueJobs.some(j => j.id === selectedTaskId)) {
      setSelectedTaskId(null)
    }
  }, [selectedTaskId, dialogueJobs])

  // Hydrate details for the effective task (focus by default, or the user's
  // manual selection). Never retain the previous session's global job.
  useEffect(() => {
    jobs.selectJob(effectiveTaskId).catch(() => {})
  }, [effectiveTaskId, jobs.selectJob])

  // Regeneration is another generate request. Task 5 gates bare POST /api/jobs
  // to require a confirmed requirement, so regeneration MUST flow through
  // clarification -> confirm (the server creates the Job on confirm, surfaced
  // via job.created SSE to useJobs). Do NOT call jobs.createJob here.
  const regenerateApplication = app => {
    const name = app.name || app.slug || app.id
    dialogue
      .send(`基于已有应用「${name}」重新生成一个更完整的版本，保留原有主题和运行形态，并改进页面效果与交互。`)
      .catch(() => {})
  }

  // Drawer entry toggle: clicking the active entry closes the drawer; clicking a
  // different one switches to it. The three entries are mutually exclusive.
  const toggleDrawerEntry = entry => {
    if (!DRAWER_ENTRIES.includes(entry)) return
    setDrawerEntry(prev => (prev === entry ? null : entry))
  }

  // The 应用项目 entry is disabled until the current dialogue has a bound
  // application project (resolvedApplication OR seededJob in the composed view).
  const view = dialogue.view
  const hasBoundApplication = !!(view && (view.resolvedApplication || view.seededJob))

  // Regenerate stays available to the (future) business/managed-agent page; kept
  // wired through apps/start/stop/rebuild so Phase 2+ can reattach it without
  // re-deriving the data plumbing. The left ApplicationsPanel is unmounted in
  // Phase 1 (its list moves to a separate page later) — the hook is retained so
  // a subsequent page can reuse it.
  void apps
  void managedAgents
  void regenerateApplication

  return (
    <main className="portal-shell">
      <TopBar />
      <LeftToolbar />
      <div className={workbenchClass}>
        <div className="wb-col wb-left">
          <SessionNav
            sessions={dialogue.sessions}
            selectedId={dialogue.session && dialogue.session.id}
            collapsed={sessionNavCollapsed}
            onToggleCollapse={() => setSessionNavCollapsed(v => !v)}
            onNewSession={dialogue.newDialogue}
            onSelect={dialogue.selectDialogue}
            onDeleteSession={dialogue.deleteDialogue}
            deletingDialogueId={dialogue.deletingDialogueId}
          />
        </div>

        <div className="wb-col wb-center">
          <ConversationWorkbench
            session={dialogue.session}
            view={dialogue.view}
            timeline={dialogue.timeline}
            questions={dialogue.questions}
            locked={dialogue.locked}
            error={dialogue.error || jobs.error}
            submitting={dialogue.submitting}
            workTrace={dialogue.workTrace}
            pendingTurn={dialogue.pendingTurn}
            focusTask={dialogue.focusTask}
            traceSteps={jobs.steps}
            drawerEntry={drawerEntry}
            onToggleDrawerEntry={toggleDrawerEntry}
            hasBoundApplication={hasBoundApplication}
            onSend={prompt => {
              if (dialogue.focusTask && dialogue.focusTask.status === 'waiting_user') {
                return jobs.answerJob(dialogue.focusTask.id, prompt)
              }
              return dialogue.send(prompt)
            }}
            onSelectRoute={dialogue.selectRoute}
            onOpenApp={dialogue.openApp}
            onAnswerBatch={dialogue.answerBatch}
            onAcceptConsolidation={dialogue.acceptConsolidation}
            onConfirm={dialogue.confirm}
            onRetry={dialogue.retry}
            onAbandon={dialogue.abandon}
            onCancelTurn={dialogue.cancelTurn}
            onConfirmChange={dialogue.confirmChange}
            onRollback={dialogue.rollback}
            onArchive={dialogue.archive}
          />
        </div>

        <WorkbenchDrawer
          activeEntry={drawerEntry}
          onClose={() => setDrawerEntry(null)}
          focusTaskActive={!!dialogue.focusTask}
          agentsProps={{
            agents: agents.agents,
            loading: agents.loading,
            error: agents.error,
            onCreateAgent: agents.createAgent,
            onDeleteAgent: agents.deleteAgent,
            deletingAgentId: agents.deletingAgentId,
          }}
          // Phase 2: thread the dialogue's generation tasks into the 任务执行
          // drawer. `jobs` is the ranked task list (all tasks for this dialogue,
          // focus task first); `activeJob` is the currently-selected task (focus
          // by default, or the user's manual selection); the rest are the same
          // useJobs accessors JobCenter needs. Records/artifacts accessors +
          // cancel/retry/repair-from-failure + snapshot save are wired here so
          // the embedded detail reuses the existing logic with no re-derivation.
          taskProps={{
            activeJob,
            jobs: dialogueJobs,
            onSelectTask,
            steps: jobs.steps,
            summary: jobs.summary,
            collaborationPlan: jobs.collaborationPlan,
            artifacts: jobs.artifacts,
            getArtifactContent: factoryApiGetArtifactContent,
            selectedStepId: jobs.selectedStepId,
            selectedAttempt: jobs.selectedAttempt,
            selectStepAttempt: jobs.selectStepAttempt,
            getRecords: jobs.getRecords,
            getUnreadCount: jobs.getUnreadCount,
            loadStepRecords: jobs.loadStepRecords,
            onCancel: jobs.cancelJob,
            onRetry: jobs.retryCurrentStep,
            onRepairFromFailure: jobs.repairFromFailure,
            onSaveSnapshot: jobs.saveStepSnapshot,
            loading: jobs.loading,
          }}
        />
      </div>
    </main>
  )
}

export default App
