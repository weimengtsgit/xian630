import { useState, useRef, useEffect } from 'react'
import { Send, X, Minimize2, Sparkles } from 'lucide-react'
import './ChatDialog.css'

export function ChatDialog({ isOpen, onClose, onMinimize }) {
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content: '你好！我是智能软件工厂的AI助手。我可以帮你生成应用、回答问题或提供技术建议。有什么我可以帮你的吗？'
    }
  ])
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const messagesEndRef = useRef(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = () => {
    if (!input.trim()) return

    const userMessage = { role: 'user', content: input }
    setMessages(prev => [...prev, userMessage])
    setInput('')
    setIsTyping(true)

    // 模拟AI响应
    setTimeout(() => {
      const responses = [
        '我理解你的需求。让我为你创建一个新的应用项目。',
        '这是一个很好的想法！我建议使用React和Vite来构建。',
        '根据你的描述，我可以帮你生成相应的代码框架。',
        '我已经分析了你的需求，正在准备生成应用...'
      ]
      const randomResponse = responses[Math.floor(Math.random() * responses.length)]

      setMessages(prev => [...prev, {
        role: 'assistant',
        content: randomResponse
      }])
      setIsTyping(false)
    }, 1500)
  }

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  if (!isOpen) return null

  return (
    <div className="chat-dialog-overlay" onClick={onClose}>
      <div className="chat-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="chat-header">
          <div className="chat-title">
            <Sparkles size={18} />
            <span>AI 应用生成助手</span>
          </div>
          <div className="chat-actions">
            <button className="chat-action-btn" onClick={onMinimize} title="最小化">
              <Minimize2 size={16} />
            </button>
            <button className="chat-action-btn" onClick={onClose} title="关闭">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="chat-messages">
          {messages.map((msg, index) => (
            <div key={index} className={`message ${msg.role}`}>
              <div className="message-content">
                {msg.content}
              </div>
            </div>
          ))}
          {isTyping && (
            <div className="message assistant">
              <div className="message-content typing">
                <span></span>
                <span></span>
                <span></span>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="chat-input-area">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="描述你想要创建的应用..."
            rows={2}
            className="chat-input"
          />
          <button
            className="send-btn"
            onClick={handleSend}
            disabled={!input.trim() || isTyping}
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  )
}
