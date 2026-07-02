import assert from 'node:assert/strict'
import {
  deriveCardAnalysisLog,
  deriveCardThinking,
} from '../src/hooks/cardStageContent.js'

const card = {
  key: 'data_capture',
  steps: [
    { id: 'step_data', stepId: 'step_data', jobId: 'job_1', attempt: 1 },
  ],
}

const timeline = [
  {
    type: 'task_execution_block',
    stepId: 'step_data',
    safeExecution: '已识别真实数据源边界。',
    taskThinking: '正在分析数据抓取路径。',
  },
]

assert.equal(
  deriveCardAnalysisLog({ card, timeline, workTraceItems: [], taskThinkingItems: [] }),
  '已识别真实数据源边界。',
  'card analysis should prefer enriched task execution blocks',
)
assert.equal(
  deriveCardThinking({ card, timeline, workTraceItems: [], taskThinkingItems: [] }),
  '正在分析数据抓取路径。',
  'card thinking should prefer enriched task execution blocks',
)

const suppressedTimeline = []
const workTraceItems = [
  {
    type: 'assistant_output',
    stepId: 'step_data',
    attempt: 1,
    payload: { summary: '数据抓取智能体：确认本体数据不可用，准备降级到互联网抓取。' },
  },
]
const taskThinkingItems = [
  {
    taskId: 'job_1',
    stepId: 'step_data',
    attempt: 1,
    content: '先校验数据源可达性，再生成抓取契约。',
  },
]

assert.equal(
  deriveCardAnalysisLog({ card, timeline: suppressedTimeline, workTraceItems, taskThinkingItems }),
  '数据抓取智能体：确认本体数据不可用，准备降级到互联网抓取。',
  'card analysis should fall back to step-attributed work trace when task blocks are suppressed',
)
assert.equal(
  deriveCardThinking({ card, timeline: suppressedTimeline, workTraceItems, taskThinkingItems }),
  '先校验数据源可达性，再生成抓取契约。',
  'card thinking should fall back to task-thinking rows when task blocks are suppressed',
)

console.log('check-agent-stage-content: ok')
