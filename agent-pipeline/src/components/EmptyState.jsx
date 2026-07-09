import { FolderOpen } from 'lucide-react'
import './EmptyState.css'

export function EmptyState() {
  return (
    <div className="empty-state">
      <FolderOpen size={48} />
      <p>请新建项目或选择已有项目</p>
    </div>
  )
}
