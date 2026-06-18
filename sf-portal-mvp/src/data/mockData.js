// 模拟应用数据
export const mockApplications = [
  {
    id: 'app-1',
    name: '航母轨迹分析',
    status: 'running',
    url: 'http://localhost:3000',
    port: 3000,
    startedAt: new Date('2024-01-18T08:30:00'),
    type: '分析系统'
  },
  {
    id: 'app-2',
    name: '态势分析原型',
    status: 'running',
    url: 'http://localhost:5173',
    port: 5173,
    startedAt: new Date('2024-01-18T09:15:00'),
    type: '态势展示'
  },
  {
    id: 'app-3',
    name: '数据采集服务',
    status: 'stopped',
    url: 'http://localhost:8000',
    port: 8000,
    startedAt: new Date('2024-01-17T14:00:00'),
    type: '后端服务'
  },
  {
    id: 'app-4',
    name: '报告生成器',
    status: 'error',
    url: 'http://localhost:4000',
    port: 4000,
    startedAt: new Date('2024-01-18T07:45:00'),
    type: '工具服务'
  }
]

// 模拟智能体数据
export const mockAgents = [
  {
    id: 'agent-1',
    name: '代码生成助手',
    type: '开发助手',
    status: 'working',
    currentTask: '生成用户管理模块',
    progress: 65,
    lastActivity: new Date('2024-01-18T10:30:00')
  },
  {
    id: 'agent-2',
    name: '测试执行器',
    type: '测试工具',
    status: 'idle',
    currentTask: null,
    progress: 0,
    lastActivity: new Date('2024-01-18T09:45:00')
  },
  {
    id: 'agent-3',
    name: '文档编写员',
    type: '文档工具',
    status: 'idle',
    currentTask: null,
    progress: 0,
    lastActivity: new Date('2024-01-18T08:00:00')
  },
  {
    id: 'agent-4',
    name: '代码审查员',
    type: '质量保障',
    status: 'completed',
    currentTask: '审查支付模块代码',
    progress: 100,
    lastActivity: new Date('2024-01-18T10:00:00')
  },
  {
    id: 'agent-5',
    name: '部署助手',
    type: '运维工具',
    status: 'idle',
    currentTask: null,
    progress: 0,
    lastActivity: new Date('2024-01-17T16:30:00')
  }
]
