import { useAgents } from '../hooks/useAgents'
import { Cpu, Activity } from 'lucide-react'
import './AgentStatus.css'

export function AgentStatus() {
  const { getWorkingAgents } = useAgents()
  const workingAgents = getWorkingAgents()

  return (
    <span className="status-item agent-status">
      <Cpu size={15} />
      <span>智能体</span>
      {workingAgents.length > 0 && (
        <span className="working-count">
          <Activity size={12} />
          {workingAgents.length}
        </span>
      )}
    </span>
  )
}
