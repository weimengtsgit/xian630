import { TopBar } from './components/TopBar'
import { LeftToolbar } from './components/LeftToolbar'
import { ApplicationsPanel } from './components/ApplicationsPanel'
import { AgentsPanel } from './components/AgentsPanel'
import { JobCenter } from './components/JobCenter'
import { ChatDialog } from './components/ChatDialog'
import { useApplications } from './hooks/useApplications'
import { useAgents } from './hooks/useAgents'
import { useJobs } from './hooks/useJobs'
import './App.css'

function App() {
  const apps = useApplications()
  const agents = useAgents()
  const jobs = useJobs()
  const regenerateApplication = app => {
    const name = app.name || app.slug || app.id
    jobs
      .createJob(`基于已有应用「${name}」重新生成一个更完整的版本，保留原有主题和运行形态，并改进页面效果与交互。`)
      .catch(() => {})
  }
  const submitChat = prompt => {
    if (jobs.activeJob && jobs.activeJob.status === 'waiting_user') {
      return jobs.answerJob(jobs.activeJob.id, prompt)
    }
    return jobs.createJob(prompt)
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
