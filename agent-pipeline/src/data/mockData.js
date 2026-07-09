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
