import { useCallback, useEffect, useMemo, useState } from 'react'
import { TopBar } from './components/TopBar'
import { LeftToolbar } from './components/LeftToolbar'
import { SessionNav } from './components/SessionNav'
import { ConversationWorkbench } from './components/ConversationWorkbench'
import { WorkbenchDrawer } from './components/WorkbenchDrawer'
import { ApplicationStorePage } from './components/ApplicationStorePage'
import { useApplications } from './hooks/useApplications'
import { useAgents } from './hooks/useAgents'
import { useJobs } from './hooks/useJobs'
import { useDialogueSessions } from './hooks/useDialogueSessions'
import { rankTasks } from './hooks/focusTask'
import { buildTaskBlocks } from './hooks/dialogueTimeline'
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
  const agents = useAgents()
  const jobs = useJobs()
  const dialogue = useDialogueSessions()
  // Phase 1 layout: the left nav owns its OWN collapse (no rail toggle), and the
  // right drawer is an overlay opened by the 3 workbench header buttons.
  const [sessionNavCollapsed, setSessionNavCollapsed] = useState(false)
  const [drawerEntry, setDrawerEntry] = useState(null)
  const [currentPage, setCurrentPage] = useState('workbench')
  const [taskStepOpenRequest, setTaskStepOpenRequest] = useState(null)
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

  // Feed the active task's step/summary state into the dialogue hook so the
  // conversation timeline can render a task_execution_block per executing step
  // (Phase 3). buildTaskBlocks is pure; the hook rebuilds the timeline on this
  // low-frequency change (useJobs refresh on SSE step.updated).
  useEffect(() => {
    dialogue.setJobStepBlocks(buildTaskBlocks(jobs.steps, jobs.summary))
  }, [jobs.steps, jobs.summary, dialogue.setJobStepBlocks])

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
  const [selectedClarificationScope, setSelectedClarificationScope] = useState(null)
  const openClarifications = useMemo(() => {
    const items = Array.isArray(dialogue.timeline) ? dialogue.timeline : []
    return items.filter(item =>
      item && item.type === 'clarification_prompt' && item.status === 'open' && item.taskId && item.stepId,
    )
  }, [dialogue.timeline])
  const activeClarification = useMemo(() => {
    if (selectedClarificationScope) {
      const selected = openClarifications.find(item =>
        item.taskId === selectedClarificationScope.taskId &&
        item.stepId === selectedClarificationScope.stepId &&
        Number(item.attempt || 0) === Number(selectedClarificationScope.attempt || 0),
      )
      if (selected) return selected
    }
    return openClarifications[0] || null
  }, [openClarifications, selectedClarificationScope])
  const onSelectClarificationScope = useCallback(scope => setSelectedClarificationScope(scope || null), [])
  const onSelectTask = useCallback(id => setSelectedTaskId(id || null), [])

  // A session switch is also a task-context switch. Re-follow the new dialogue's
  // focus task (clear any manual selection from the previous session) and
  // hydrate its details.
  useEffect(() => {
    setSelectedTaskId(null)
    setSelectedClarificationScope(null)
  }, [dialogue.selectedDialogueId])

  // If the manually-selected task leaves the dialogue's job list (deleted, or
  // rotated out by a later list snapshot), fall back to the focus task so the
  // drawer never pins a stale id.
  useEffect(() => {
    if (selectedTaskId && !dialogueJobs.some(j => j.id === selectedTaskId)) {
      setSelectedTaskId(null)
    }
  }, [selectedTaskId, dialogueJobs])

  // If the user had clicked a specific clarification card and that card is no
  // longer open (answered/stale after SSE refresh), fall back to the first open
  // clarification. This prevents a later send from routing to a stale step.
  useEffect(() => {
    if (!selectedClarificationScope) return
    const stillOpen = openClarifications.some(item =>
      item.taskId === selectedClarificationScope.taskId &&
      item.stepId === selectedClarificationScope.stepId &&
      Number(item.attempt || 0) === Number(selectedClarificationScope.attempt || 0),
    )
    if (!stillOpen) setSelectedClarificationScope(null)
  }, [selectedClarificationScope, openClarifications])

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
    return dialogue
      .send(`基于已有应用「${name}」重新生成一个更完整的版本，保留原有主题和运行形态，并改进页面效果与交互。`)
      .catch(() => {})
  }

  const regenerateApplicationFromStore = app => {
    setCurrentPage('workbench')
    return regenerateApplication(app)
  }

  // Drawer entry toggle: clicking the active entry closes the drawer; clicking a
  // different one switches to it. The three entries are mutually exclusive.
  const toggleDrawerEntry = entry => {
    if (!DRAWER_ENTRIES.includes(entry)) return
    setDrawerEntry(prev => (prev === entry ? null : entry))
  }

  const openTaskStepFromGraph = useCallback(card => {
    const stepId = card && card.stepId
    if (!stepId) return
    const sm = (Array.isArray(jobs.summary) ? jobs.summary : []).find(item => item && item.step_id === stepId)
    const step = (Array.isArray(jobs.steps) ? jobs.steps : []).find(item => item && item.id === stepId)
    const attempt =
      (sm && (sm.attempt ?? sm.latest_attempt)) ??
      (step && (step.attempt ?? step.latest_attempt)) ??
      (card.step && (card.step.attempt ?? card.step.latest_attempt)) ??
      1
    const taskId = (step && (step.job_id || step.jobId)) || (card.step && (card.step.job_id || card.step.jobId)) || ''
    if (taskId) setSelectedTaskId(taskId)
    setDrawerEntry('task')
    jobs.selectStepAttempt(stepId, attempt)
    setTaskStepOpenRequest({ stepId, attempt, requestedAt: Date.now() })
  }, [jobs.summary, jobs.steps, jobs.selectStepAttempt])

  // The 工作空间 entry is disabled until the current dialogue has a concrete
  // generated application id. A seeded job alone can exist before code_generation
  // has registered the project, so it is not enough to enable the drawer.
  const view = dialogue.view
  const applicationProjectId =
    (view && view.resolvedApplication && view.resolvedApplication.id) ||
    (view && view.seededJob && (view.seededJob.application_id || view.seededJob.created_app_id)) ||
    ''
  const hasBoundApplication = !!applicationProjectId

  // Regenerate stays available to the (future) business/managed-agent page; kept
  // wired through apps/start/stop/rebuild so Phase 2+ can reattach it without
  // re-deriving the data plumbing. The left ApplicationsPanel is unmounted in
  // Phase 1 (its list moves to a separate page later).

  return (
    <main className="portal-shell">
      <TopBar />
      <LeftToolbar activePage={currentPage} onNavigate={setCurrentPage} />
      {currentPage === 'workbench' ? (
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
              clarificationScope={activeClarification}
              onSelectClarificationScope={onSelectClarificationScope}
              traceSteps={jobs.steps}
              drawerEntry={drawerEntry}
              onToggleDrawerEntry={toggleDrawerEntry}
              onOpenTaskStep={openTaskStepFromGraph}
              onConfirmTaskStep={jobs.confirmStep}
              hasBoundApplication={hasBoundApplication}
              onSend={(prompt, options = {}) => {
                if (activeClarification) {
                  return jobs.answerJob(activeClarification.taskId, prompt, {
                    stepId: activeClarification.stepId,
                    attempt: activeClarification.attempt,
                    attachmentIds: options.attachmentIds || [],
                  })
                }
                if (dialogue.focusTask && dialogue.focusTask.status === 'waiting_user') {
                  return jobs.answerJob(dialogue.focusTask.id, prompt, { attachmentIds: options.attachmentIds || [] })
                }
                return dialogue.send(prompt, options)
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
              onOpenApplicationStore={() => setCurrentPage('appStore')}
            />
          </div>

          <WorkbenchDrawer
            activeEntry={drawerEntry}
            onClose={() => setDrawerEntry(null)}
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
              stepOpenRequest: taskStepOpenRequest,
              getRecords: jobs.getRecords,
              getUnreadCount: jobs.getUnreadCount,
              loadStepRecords: jobs.loadStepRecords,
              onCancel: jobs.cancelJob,
              onRetry: jobs.retryCurrentStep,
              onRepairFromFailure: jobs.repairFromFailure,
              onSaveSnapshot: jobs.saveStepSnapshot,
              loading: jobs.loading,
            }}
            applicationProps={{
              application: view && view.resolvedApplication ? view.resolvedApplication : null,
              applicationId: applicationProjectId,
              dialogueId: dialogue.session && dialogue.session.id,
              seededJob: view && view.seededJob ? view.seededJob : null,
              onDraftApplied: () => dialogue.session && dialogue.selectDialogue(dialogue.session.id),
            }}
          />
        </div>
      ) : null}
      {currentPage === 'appStore' ? (
        <ApplicationStorePage
          apps={apps.apps}
          loading={apps.loading}
          error={apps.error}
          actionById={apps.actionById}
          generationStats={apps.generationStats}
          refresh={apps.refresh}
          startApplication={apps.startApplication}
          stopApplication={apps.stopApplication}
          restartApplication={apps.restartApplication}
          deleteApplication={apps.deleteApplication}
          onRegenerate={regenerateApplicationFromStore}
        />
      ) : null}
    </main>
  )
}

export default App
