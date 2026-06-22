import { TopBar } from './components/TopBar'
import { LeftToolbar } from './components/LeftToolbar'
import { ApplicationsPanel } from './components/ApplicationsPanel'
import { AgentsPanel } from './components/AgentsPanel'
import { JobCenter } from './components/JobCenter'
import { ClarificationPanel } from './components/ClarificationPanel'
import { ChatDialog } from './components/ChatDialog'
import { useApplications } from './hooks/useApplications'
import { useAgents } from './hooks/useAgents'
import { useJobs } from './hooks/useJobs'
import { useClarification } from './hooks/useClarification'
import { factoryApi } from './api/client'
import './App.css'

// Stable wrapper so JobCenter gets a plain function it can call to lazily load
// a selected artifact's TEXT content (never eagerly fetched).
const factoryApiGetArtifactContent = id => factoryApi.getArtifactContent(id)

function App() {
  const apps = useApplications()
  const agents = useAgents()
  const jobs = useJobs()
  const clarification = useClarification()

  // Regeneration is another generate request. Task 5 gates bare POST /api/jobs
  // to require a confirmed requirement, so regeneration MUST flow through
  // clarification -> confirm (the server creates the Job on confirm, surfaced
  // via job.created SSE to useJobs). Do NOT call jobs.createJob here.
  const regenerateApplication = app => {
    const name = app.name || app.slug || app.id
    clarification
      .send(`基于已有应用「${name}」重新生成一个更完整的版本，保留原有主题和运行形态，并改进页面效果与交互。`)
      .catch(() => {})
  }

  // Chat submit routing:
  //  - if a running job is waiting for user input, answer THAT job;
  //  - otherwise start / continue a clarification session (clarification ->
  //    confirm is the only path that creates a Job now).
  const submitChat = prompt => {
    if (jobs.activeJob && jobs.activeJob.status === 'waiting_user') {
      return jobs.answerJob(jobs.activeJob.id, prompt)
    }
    return clarification.send(prompt)
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
          <ClarificationPanel
            session={clarification.session}
            messages={clarification.messages}
            questions={clarification.questions}
            requirement={clarification.requirement}
            blueprints={clarification.blueprints}
            error={clarification.error}
            onAnswerBatch={answers => clarification.answerBatch(answers)}
            onConfirm={clarification.confirm}
            onRetry={clarification.retry}
            onAbandon={clarification.abandon}
          />
          <ChatDialog
            activeJob={jobs.activeJob}
            jobError={jobs.error}
            onSubmit={submitChat}
          />
        </div>

        <div className="wb-col wb-right">
          <AgentsPanel
            agents={agents.agents}
            loading={agents.loading}
            error={agents.error}
            onCreateAgent={agents.createAgent}
          />
        </div>
      </div>
    </main>
  )
}

export default App
