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

// 模拟智能体数据（生产流水线：业务逻辑 → 并行(界面解析/数据抓取) → 生产交付）
export const mockAgents = [
  {
    id: 'agent-business',
    name: '业务逻辑智能体',
    type: '业务逻辑',
    status: 'working',
    currentTask: '业务流程建模与逻辑拆解',
    progress: 72,
    lastActivity: new Date()
  },
  {
    id: 'agent-prototype',
    name: '界面解析智能体',
    type: '界面解析',
    status: 'idle',
    currentTask: null,
    progress: 0,
    lastActivity: new Date()
  },
  {
    id: 'agent-data',
    name: '数据抓取智能体',
    type: '数据抓取',
    status: 'idle',
    currentTask: null,
    progress: 0,
    lastActivity: new Date()
  },
  {
    id: 'agent-production',
    name: '生产交付智能体',
    type: '生产交付',
    status: 'idle',
    currentTask: null,
    progress: 0,
    lastActivity: new Date()
  }
]
