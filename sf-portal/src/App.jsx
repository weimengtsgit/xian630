import { useState } from 'react'
import { TopBar } from './components/TopBar'
import { LeftToolbar } from './components/LeftToolbar'
import { AgentsPanel } from './components/AgentsPanel'
import { ChatDialog } from './components/ChatDialog'
import { extractKeywords } from './utils/keywordExtractor'
import './App.css'

function App() {
  const [isChatOpen, setIsChatOpen] = useState(false)
  const [isChatMinimized, setIsChatMinimized] = useState(false)
  // 用户在 AI 应用生成助手对话中输入的需求，提炼关键字后流入流水线首端卡片
  const [userInput, setUserInput] = useState({ text: '', keywords: [] })

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

  // 用户提交对话内容 → 提炼关键字
  const handleUserSubmit = (text) => {
    setUserInput({ text, keywords: extractKeywords(text) })
  }

  return (
    <main className="portal-shell">
      <TopBar />
      <LeftToolbar />
      <div className="portal-content">
        <AgentsPanel userInput={userInput} />
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
