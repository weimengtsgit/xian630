import { useStages } from '../hooks/useStages'
import { Cpu, Activity } from 'lucide-react'
import './AgentStatus.css'

export function AgentStatus() {
  const { stages } = useStages()
  const total = stages.length
  const done = stages.filter(s => s.status === 'completed').length

  return (
    <span className="status-item agent-status">
      <Cpu size={15} />
      <span>智能体</span>
      {total > 0 && (
        <span className="working-count">
          <Activity size={12} />
          {done}/{total}
        </span>
      )}
    </span>
  )
}
