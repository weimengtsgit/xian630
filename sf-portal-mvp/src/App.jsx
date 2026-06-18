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
            onStart={apps.startApplication}
            onStop={apps.stopApplication}
            onRebuild={apps.restartApplication}
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
            onSubmit={jobs.createJob}
          />
        </div>

        <div className="wb-col wb-right">
          <AgentsPanel agents={agents.agents} loading={agents.loading} error={agents.error} />
        </div>
      </div>
    </main>
  )
}

export default App
