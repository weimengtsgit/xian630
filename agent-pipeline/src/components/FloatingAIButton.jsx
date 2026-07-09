import { Sparkles } from 'lucide-react'
import './FloatingAIButton.css'

export function FloatingAIButton({ onClick, isActive }) {
  return (
    <button
      className={`floating-ai-button ${isActive ? 'active' : ''}`}
      onClick={onClick}
      title="AI 应用生成助手"
    >
      <Sparkles size={24} />
      {isActive && <span className="pulse-ring"></span>}
    </button>
  )
}
