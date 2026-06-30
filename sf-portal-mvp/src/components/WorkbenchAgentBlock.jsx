import { ChevronDown, ChevronRight, FileText, MonitorCheck } from 'lucide-react'
import { useState } from 'react'
import { WorkbenchTrack } from './WorkbenchTracks'

const CONFIRM_LABEL = {
  business_logic: '确认业务逻辑并继续',
  interface_parsing: '确认界面解析并继续',
  data_capture: '确认数据抓取并继续',
}

export function WorkbenchAgentBlock({ card, thinking, analysisLog, questions = [], onConfirm, onOpenArtifact }) {
  const [open, setOpen] = useState(!isFolded(card))
  if (!card) return null
  const canConfirm = ['waiting_artifact_confirmation', 'waiting_user_clarification'].includes(card.state) && CONFIRM_LABEL[card.key]
  return (
    <section className={`cw-agent-block cw-agent-block-${card.key} ${open ? 'is-open' : 'is-folded'}`}>
      <button type="button" className="cw-agent-block-head" onClick={() => setOpen(v => !v)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <strong>{card.label}</strong>
        <span>{card.currentAction || card.summary || card.subStage || '未开始'}</span>
      </button>
      {open ? (
        <div className="cw-agent-block-body">
          <WorkbenchTrack cardKey={card.key} activeLabel={card.subStage || card.currentAction} failedLabel={card.state === 'failed' ? card.currentAction : ''} />
          {thinking ? <section className="cw-agent-section"><h4>思考过程</h4><pre>{thinking}</pre></section> : null}
          {card.summary ? <section className="cw-agent-section"><h4>思考摘要</h4><p>{card.summary}</p></section> : null}
          {analysisLog ? <section className="cw-agent-section"><h4>模型分析过程</h4><pre>{analysisLog}</pre></section> : null}
          {questions.length ? <QuestionList questions={questions} /> : null}
          {card.artifacts.length ? <ArtifactList artifacts={card.artifacts} onOpenArtifact={onOpenArtifact} /> : null}
          {canConfirm ? <button type="button" className="cw-agent-confirm" onClick={() => onConfirm && onConfirm(card.key)}>{CONFIRM_LABEL[card.key]}</button> : null}
        </div>
      ) : (
        <div className="cw-agent-folded">
          {card.artifacts.map(item => <button key={item.id || item.path} type="button" onClick={() => onOpenArtifact && onOpenArtifact(item)}>{item.label || item.path}</button>)}
        </div>
      )}
    </section>
  )
}

function isFolded(card) {
  return card.state === 'confirmed' || card.state === 'delivered'
}

function QuestionList({ questions }) {
  return (
    <section className="cw-agent-section">
      <h4>澄清项</h4>
      {questions.map(q => <p key={q.id || q.question}>{q.question}</p>)}
    </section>
  )
}

function ArtifactList({ artifacts, onOpenArtifact }) {
  return (
    <section className="cw-agent-section cw-artifact-list">
      <h4>产物</h4>
      {artifacts.map(item => (
        <button key={item.id || item.path} type="button" onClick={() => onOpenArtifact && onOpenArtifact(item)}>
          {item.kind === 'interface_preview' ? <MonitorCheck size={14} /> : <FileText size={14} />}
          <span>{item.label || item.path}</span>
        </button>
      ))}
    </section>
  )
}
