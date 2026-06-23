import { TopBar } from './components/TopBar'
import { LeftToolbar } from './components/LeftToolbar'
import { ApplicationsPanel } from './components/ApplicationsPanel'
import { AgentsPanel } from './components/AgentsPanel'
import { JobCenter } from './components/JobCenter'
import { ConversationWorkbench } from './components/ConversationWorkbench'
import { useApplications } from './hooks/useApplications'
import { useAgents } from './hooks/useAgents'
import { useJobs } from './hooks/useJobs'
import { useConversationSessions } from './hooks/useConversationSessions'
import { factoryApi } from './api/client'
import './App.css'

// Stable wrapper so JobCenter gets a plain function it can call to lazily load
// a selected artifact's TEXT content (never eagerly fetched).
const factoryApiGetArtifactContent = id => factoryApi.getArtifactContent(id)

function App() {
  const apps = useApplications()
  const agents = useAgents()
  const jobs = useJobs()
  const conversation = useConversationSessions()

  // Regeneration is another generate request. Task 5 gates bare POST /api/jobs
  // to require a confirmed requirement, so regeneration MUST flow through
  // clarification -> confirm (the server creates the Job on confirm, surfaced
  // via job.created SSE to useJobs). Do NOT call jobs.createJob here.
  const regenerateApplication = app => {
    const name = app.name || app.slug || app.id
    conversation
      .send(`基于已有应用「${name}」重新生成一个更完整的版本，保留原有主题和运行形态，并改进页面效果与交互。`)
      .catch(() => {})
  }

  return (
    <main className="portal-shell">
      <TopBar />
      <LeftToolbar />
      <div className="workbench">
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
          />
        </div>

        <div className="wb-col wb-center">
          <JobCenter
            activeJob={jobs.activeJob}
            steps={jobs.steps}
            loading={jobs.loading}
            onCancel={jobs.cancelJob}
            onRetry={jobs.retryCurrentStep}
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
          <ConversationWorkbench
            session={conversation.session}
            sessions={conversation.sessions}
            timeline={conversation.timeline}
            questions={conversation.questions}
            error={conversation.error || jobs.error}
            submitting={conversation.submitting}
            selectedBusinessAgents={conversation.selectedBusinessAgents}
            onRemoveBusinessAgent={conversation.removeBusinessAgent}
            onMoveBusinessAgent={conversation.moveBusinessAgent}
            historyOpen={conversation.historyOpen}
            setHistoryOpen={conversation.setHistoryOpen}
            onNewSession={conversation.newSession}
            onSelectSession={conversation.selectSession}
            onSend={prompt => {
              if (jobs.activeJob && jobs.activeJob.status === 'waiting_user') {
                return jobs.answerJob(jobs.activeJob.id, prompt)
              }
              return conversation.send(prompt)
            }}
            onAnswerBatch={conversation.answerBatch}
            onConfirm={conversation.confirm}
            onRetry={conversation.retry}
            onAbandon={conversation.abandon}
          />
        </div>

        <div className="wb-col wb-right">
          <AgentsPanel
            agents={agents.agents}
            softwareAgents={agents.softwareAgents}
            businessAgents={agents.businessAgents}
            loading={agents.loading}
            error={agents.error}
            onCreateAgent={agents.createAgent}
            selectedBusinessAgentIds={conversation.selectedBusinessAgentIds}
            onAddBusinessAgent={conversation.addBusinessAgent}
            onRemoveBusinessAgent={conversation.removeBusinessAgent}
            onCreateAuthoringSession={agents.createAuthoringSession}
            onSendAuthoringMessage={agents.sendAuthoringMessage}
            onFinalizeAuthoring={agents.finalizeAuthoring}
            onUpdateBusinessAgent={agents.updateBusinessAgent}
            onSetBusinessAgentEnabled={agents.setBusinessAgentEnabled}
          />
        </div>
      </div>
    </main>
  )
}

export default App
