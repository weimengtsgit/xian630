import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { TopBar } from './components/TopBar'
import { LeftToolbar } from './components/LeftToolbar'
import { ApplicationsPanel } from './components/ApplicationsPanel'
import { AgentsPanel } from './components/AgentsPanel'
import { JobCenter } from './components/JobCenter'
import { ConversationWorkbench } from './components/ConversationWorkbench'
import { useApplications } from './hooks/useApplications'
import { useManagedAgents } from './hooks/useManagedAgents'
import { useAgents } from './hooks/useAgents'
import { useJobs } from './hooks/useJobs'
import { useDialogueSessions } from './hooks/useDialogueSessions'
import { composerLockedByGenerationStage } from './hooks/composerStageLock'
import { factoryApi } from './api/client'
import './App.css'

// Stable wrapper so JobCenter gets a plain function it can call to lazily load
// a selected artifact's TEXT content (never eagerly fetched).
const factoryApiGetArtifactContent = id => factoryApi.getArtifactContent(id)

function App() {
  const apps = useApplications()
  const managedAgents = useManagedAgents()
  const agents = useAgents()
  const jobs = useJobs()
  const dialogue = useDialogueSessions()
  const [leftPanelHidden, setLeftPanelHidden] = useState(false)
  const [rightPanelHidden, setRightPanelHidden] = useState(false)
  const workbenchClass = [
    'workbench',
    leftPanelHidden ? 'left-hidden' : '',
    rightPanelHidden ? 'right-hidden' : '',
  ].filter(Boolean).join(' ')

  // Feed the live job list into the dialogue hook so it can select a dialogue-
  // scoped focus task (Constraint #10). The hook filters by dialogue_id
  // server-side; passing the full list is cheap and stays in sync on every
  // job.created/updated SSE.
  useEffect(() => {
    dialogue.setJobsForFocus(jobs.jobs)
  }, [jobs.jobs, dialogue.setJobsForFocus])

  // A session switch is also a task-context switch. Hydrate details only for
  // this dialogue's focus task; never retain the previous session's global job.
  useEffect(() => {
    jobs.selectJob(dialogue.focusTask ? dialogue.focusTask.id : null).catch(() => {})
  }, [dialogue.focusTask, jobs.selectJob])

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

  return (
    <main className="portal-shell">
      <TopBar />
      <LeftToolbar />
      <div className={workbenchClass}>
        {leftPanelHidden ? (
          <button
            type="button"
            className="side-rail-toggle side-rail-toggle-left"
            onClick={() => setLeftPanelHidden(false)}
            title="显示左侧智能体"
            aria-label="显示左侧智能体"
          >
            <ChevronRight size={16} />
          </button>
        ) : null}

        {!leftPanelHidden ? (
          <div className="wb-col wb-left">
            <ApplicationsPanel
              apps={apps.apps}
              loading={apps.loading}
              error={apps.error}
              actionById={apps.actionById}
              onStart={apps.startApplication}
              onStop={apps.stopApplication}
              onRebuild={apps.restartApplication}
              onRegenerate={regenerateApplication}
              onDelete={apps.deleteApplication}
              onRefresh={apps.refresh}
              managedAgents={managedAgents.managedAgents}
              managedAgentsLoading={managedAgents.loading}
              managedAgentsError={managedAgents.error}
              onRefreshManagedAgents={managedAgents.refresh}
              onHidePanel={() => setLeftPanelHidden(true)}
            />
          </div>
        ) : null}

        <div className="wb-col wb-center">
          <ConversationWorkbench
            session={dialogue.session}
            view={dialogue.view}
            sessions={dialogue.sessions}
            timeline={dialogue.timeline}
            questions={dialogue.questions}
            locked={dialogue.locked}
            error={dialogue.error || jobs.error}
            submitting={dialogue.submitting}
            deletingDialogueId={dialogue.deletingDialogueId}
            historyOpen={dialogue.historyOpen}
            setHistoryOpen={dialogue.setHistoryOpen}
            workTrace={dialogue.workTrace}
            pendingTurn={dialogue.pendingTurn}
            focusTask={dialogue.focusTask}
            traceSteps={jobs.steps}
            composerStageLocked={composerLockedByGenerationStage(jobs.steps, dialogue.focusTask, dialogue.session && dialogue.session.status)}
            taskPanel={
              <JobCenter
                activeJob={dialogue.focusTask || null}
                steps={jobs.steps}
                loading={jobs.loading}
                onCancel={jobs.cancelJob}
                onRetry={jobs.retryCurrentStep}
                onRepairFromFailure={jobs.repairFromFailure}
                summary={jobs.summary}
                artifacts={jobs.artifacts}
                selectedStepId={jobs.selectedStepId}
                selectedAttempt={jobs.selectedAttempt}
                selectStepAttempt={jobs.selectStepAttempt}
                getRecords={jobs.getRecords}
                getUnreadCount={jobs.getUnreadCount}
                loadStepRecords={jobs.loadStepRecords}
                getArtifactContent={factoryApiGetArtifactContent}
              />
            }
            onNewSession={dialogue.newDialogue}
            onSelectSession={dialogue.selectDialogue}
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
            onDeleteSession={dialogue.deleteDialogue}
            onCancelTurn={dialogue.cancelTurn}
            onConfirmChange={dialogue.confirmChange}
            onRollback={dialogue.rollback}
            onArchive={dialogue.archive}
          />
        </div>

        {!rightPanelHidden ? (
          <div className="wb-col wb-right">
            <AgentsPanel
              agents={agents.agents}
              loading={agents.loading}
              error={agents.error}
              onCreateAgent={agents.createAgent}
              onDeleteAgent={agents.deleteAgent}
              deletingAgentId={agents.deletingAgentId}
              onHidePanel={() => setRightPanelHidden(true)}
            />
          </div>
        ) : null}

        {rightPanelHidden ? (
          <button
            type="button"
            className="side-rail-toggle side-rail-toggle-right"
            onClick={() => setRightPanelHidden(false)}
            title="显示右侧智能体"
            aria-label="显示右侧智能体"
          >
            <ChevronLeft size={16} />
          </button>
        ) : null}
      </div>
    </main>
  )
}

export default App
