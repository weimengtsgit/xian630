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
} from 'lucide-react'

const menuItems = [
  { label: '首页', icon: Home, page: 'workbench' },
  { label: '应用商店', icon: Store, page: 'appStore' },
  { label: '导航', icon: Compass },
  { label: '图层', icon: Layers },
  { label: '文档', icon: FileText },
  { label: '图库', icon: Image },
  { label: '数据', icon: Database },
  { label: '设置', icon: Settings },
  { label: '帮助', icon: HelpCircle },
]

export function LeftToolbar({ activePage = 'workbench', onNavigate }) {
  return (
    <aside className="left-toolbar" aria-label="功能菜单">
      {menuItems.map((item) => {
        const Icon = item.icon
        const active = item.page && activePage === item.page
        return (
          <button
            key={item.label}
            type="button"
            title={item.label}
            className={active ? 'is-active' : ''}
            aria-pressed={active || undefined}
            onClick={() => item.page && onNavigate && onNavigate(item.page)}
          >
            <Icon size={20} />
            <span className="toolbar-label">{item.label}</span>
          </button>
        )
      })}
    </aside>
  )
}
