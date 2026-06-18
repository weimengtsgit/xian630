import assert from 'node:assert/strict'
import { selectDisplayJob, displayJobTitle } from '../src/hooks/jobSelection.js'

const running = { id: 'job_running', status: 'running', user_prompt: '运行中的任务' }
const failed = { id: 'job_failed', status: 'failed', user_prompt: '失败任务' }
const completed = {
  id: 'job_completed',
  status: 'completed',
  user_prompt: '生成一个航母编队近一个月航行轨迹和事件的东海地图复盘应用',
}

assert.equal(selectDisplayJob([failed])?.id, 'job_failed')
assert.equal(selectDisplayJob([completed])?.id, 'job_completed')
assert.equal(selectDisplayJob([completed, failed, running])?.id, 'job_running')
assert.equal(
  displayJobTitle(completed),
  '生成一个航母编队近一个月航行轨迹和事件的东海地图复盘应用',
)
assert.equal(displayJobTitle({ id: 'job_empty' }), 'job_empty')
