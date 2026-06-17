import { useState } from 'react'
import { TopBar } from './components/TopBar'
import { LeftToolbar } from './components/LeftToolbar'
import { ApplicationsPanel } from './components/ApplicationsPanel'
import { AgentsPanel } from './components/AgentsPanel'
import { FloatingAIButton } from './components/FloatingAIButton'
import { ChatDialog } from './components/ChatDialog'
import './App.css'

function App() {
  const [isChatOpen, setIsChatOpen] = useState(false)
  const [isChatMinimized, setIsChatMinimized] = useState(false)

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

  return (
    <main className="portal-shell">
      <TopBar />
      <LeftToolbar />
      <div className="portal-content">
        <div className="content-vertical">
          <ApplicationsPanel />
          <AgentsPanel />
        </div>
      </div>
      <FloatingAIButton
        onClick={toggleChat}
        isActive={isChatOpen || isChatMinimized}
      />
      <ChatDialog
        isOpen={isChatOpen}
        onClose={closeChat}
        onMinimize={minimizeChat}
      />
    </main>
  )
}

export default App
