import { useState, useEffect, useCallback } from 'react'
import { TopBar } from './components/TopBar'
import { LeftToolbar } from './components/LeftToolbar'
import { AgentsPanel } from './components/AgentsPanel'
import { ChatDialog } from './components/ChatDialog'
import { ProjectNav } from './components/ProjectNav'
import { EmptyState } from './components/EmptyState'
import { extractKeywords } from './utils/keywordExtractor'
import './App.css'

function App() {
  const [isChatOpen, setIsChatOpen] = useState(false)
  const [isChatMinimized, setIsChatMinimized] = useState(false)
  const [userInput, setUserInput] = useState({ text: '', keywords: [] })
  const [projects, setProjects] = useState([])
  const [selectedProject, setSelectedProject] = useState(null)

  // 加载项目列表
  const refreshProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects')
      const data = await res.json()
      setProjects(data.projects || [])
    } catch { /* 静默失败 */ }
  }, [])

  useEffect(() => { refreshProjects() }, [refreshProjects])

  // 新建项目
  const handleNewProject = useCallback(async (name) => {
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const proj = await res.json()
      setProjects(prev => [proj, ...prev])
      setSelectedProject(proj)
      window.history.replaceState(null, '', `?projectname=${proj.projectname}`)
    } catch { /* 静默失败 */ }
  }, [])

  // 选择项目
  const handleSelectProject = useCallback((proj) => {
    setSelectedProject(proj)
    window.history.replaceState(null, '', `?projectname=${proj.projectname}`)
  }, [])

  // 删除项目
  const handleDeleteProject = useCallback(async (id) => {
    try {
      await fetch(`/api/projects/${id}`, { method: 'DELETE' })
      setProjects(prev => prev.filter(p => p.id !== id))
      setSelectedProject(prev => prev?.id === id ? null : prev)
    } catch { /* 静默失败 */ }
  }, [])

  const toggleChat = () => {
    if (isChatOpen) {
      setIsChatOpen(false)
      setIsChatMinimized(false)
    } else {
      setIsChatOpen(true)
    }
  }

  const closeChat = () => {
    setIsChatOpen(false)
    setIsChatMinimized(false)
  }

  const minimizeChat = () => {
    setIsChatOpen(false)
    setIsChatMinimized(true)
  }

  const handleUserSubmit = (text) => {
    setUserInput({ text, keywords: extractKeywords(text) })
  }

  return (
    <main className="portal-shell">
      <TopBar />
      <LeftToolbar />
      <div className="portal-content">
        <ProjectNav
          projects={projects}
          selectedId={selectedProject?.id}
          onNewProject={handleNewProject}
          onSelectProject={handleSelectProject}
          onDeleteProject={handleDeleteProject}
        />
        <div className="portal-main">
          {selectedProject
            ? <AgentsPanel key={selectedProject.id} userInput={userInput} projectname={selectedProject.projectname} projectId={selectedProject.id} />
            : <EmptyState />
          }
        </div>
      </div>
      <ChatDialog
        isOpen={isChatOpen}
        onClose={closeChat}
        onMinimize={minimizeChat}
        onUserSubmit={handleUserSubmit}
      />
    </main>
  )
}

export default App
