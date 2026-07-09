import {
  Home,
  Compass,
  Layers,
  FileText,
  Image,
  Database,
  Settings,
  HelpCircle,
  Store,
  GitBranch,
} from 'lucide-react'

const menuItems = [
  { label: '首页', icon: Home, href: 'http://220.154.5.91:8000/' },
  { label: '智能体广场', icon: Store, href: 'http://220.154.5.91:18016/' },
  { label: '智能体流水线', icon: GitBranch },
  { label: '导航', icon: Compass },
  { label: '图层', icon: Layers },
  { label: '文档', icon: FileText },
  { label: '图库', icon: Image },
  { label: '数据', icon: Database },
  { label: '设置', icon: Settings },
  { label: '帮助', icon: HelpCircle },
]

export function LeftToolbar() {
  return (
    <aside className="left-toolbar" aria-label="功能菜单">
      {menuItems.map((item) => {
        const Icon = item.icon
        return (
          <button
            key={item.label}
            type="button"
            title={item.label}
            onClick={() => {
              if (item.href) {
                window.open(item.href, '_blank', 'noopener,noreferrer')
              }
            }}
          >
            <Icon size={20} />
            <span className="toolbar-label">{item.label}</span>
          </button>
        )
      })}
    </aside>
  )
}
