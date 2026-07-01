import { ChevronDown, ChevronRight, FileText, MonitorCheck } from 'lucide-react'
import { useState } from 'react'
import { WorkbenchTrack } from './WorkbenchTracks'
import { isPreviewableArtifact } from '../utils/workbenchArtifact'

const CONFIRM_LABEL = {
  business_logic: '需求确认',
  interface_parsing: '界面确认',
  data_capture: '数据确认',
}

const BLOCK_TITLE = {
  business_logic: '需求理解结果',
  interface_parsing: '界面确认',
  data_capture: '数据方案确认',
}

export function WorkbenchAgentBlock({ card, thinking, analysisLog, questions = [], onConfirm, onOpenArtifact, onSubmitCredential }) {
  const [open, setOpen] = useState(!isFolded(card))
  // TEMP DEBUG: log card data to diagnose empty blocks
  if (typeof window !== 'undefined') {
    console.log('[WorkbenchAgentBlock]', card.key, { state: card.state, steps: (card.steps || []).length, summary: card.summary, artifacts: (card.artifacts || []).length, thinking: (thinking || '').length })
  }
  // credentialDrafts holds the in-progress plaintext credential the user is
  // typing for each credential question, keyed by question id. The draft lives
  // ONLY in component state; it is never rendered as text (the input is
  // type="password") and is sent solely via onSubmitCredential → the controlled
  // credential boundary, which swaps it for an opaque handle. It is never
  // persisted, logged, or echoed into summaries/attachments/artifacts.
  const [credentialDrafts, setCredentialDrafts] = useState({})
  if (!card) return null
  const canConfirm = ['waiting_artifact_confirmation', 'waiting_user_clarification'].includes(card.state) && CONFIRM_LABEL[card.key]
  const previewableArtifacts = (card.artifacts || []).filter(isPreviewableArtifact)
  const block = (
    <section className={`cw-agent-block cw-agent-block-${card.key} ${open ? 'is-open' : 'is-folded'}`}>
      <button type="button" className="cw-agent-block-head" onClick={() => setOpen(v => !v)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <strong>{BLOCK_TITLE[card.key] || card.label}</strong>
        <span>{card.currentAction || card.summary || card.subStage || '未开始'}</span>
      </button>
      {open ? (
        <div className="cw-agent-block-body">
          <WorkbenchTrack cardKey={card.key} activeLabel={card.subStage || card.currentAction} failedLabel={card.state === 'failed' ? card.currentAction : ''} card={card} />
          {thinking ? <section className="cw-agent-section"><h4>思考过程</h4><pre>{thinking}</pre></section> : null}
          {card.summary ? <section className="cw-agent-section"><h4>思考摘要</h4><p>{card.summary}</p></section> : null}
          {analysisLog ? <section className="cw-agent-section"><h4>模型分析过程</h4><pre>{analysisLog}</pre></section> : null}
          {questions.length ? <QuestionList questions={questions} onSubmitCredential={onSubmitCredential} credentialDrafts={credentialDrafts} setCredentialDrafts={setCredentialDrafts} /> : null}
          {previewableArtifacts.length ? <ArtifactList artifacts={previewableArtifacts} onOpenArtifact={onOpenArtifact} /> : null}
          {canConfirm ? <button type="button" className="cw-agent-confirm" onClick={() => onConfirm && onConfirm(card)}>{CONFIRM_LABEL[card.key]}</button> : null}
        </div>
      ) : (
        <div className="cw-agent-folded">
          {previewableArtifacts.map(item => <button key={item.id || item.path} type="button" onClick={() => onOpenArtifact && onOpenArtifact(item)}>{item.label || item.path}</button>)}
        </div>
      )}
    </section>
  )
  if (card.key === 'interface_parsing' || card.key === 'data_capture') {
    return (
      <>
        <div className="cw-agent-block-divider" aria-hidden="true" />
        {block}
      </>
    )
  }
  return block
}

function isFolded(card) {
  // Never auto-fold: the user expects each agent block (业务逻辑 / 界面解析 /
  // 数据抓取 / 生产交付) to show its content (思考过程, 思考摘要, 产物) inline in
  // the conversation, not collapse to a bare header line once the stage is done.
  // The head button still toggles open/close manually.
  return false
}

function QuestionList({ questions, onSubmitCredential, credentialDrafts, setCredentialDrafts }) {
  return (
    <section className="cw-agent-section">
      <h4>澄清项</h4>
      {questions.map(q =>
        q.inputType === 'credential' ? (
          <label key={q.id || q.question} className="cw-credential-input">
            <span>{q.question}</span>
            <input
              type="password"
              autoComplete="off"
              value={credentialDrafts[q.id] || ''}
              onChange={event => setCredentialDrafts(prev => ({ ...prev, [q.id]: event.target.value }))}
              placeholder="输入受控凭证"
            />
            <button type="button" onClick={() => onSubmitCredential && onSubmitCredential(q, credentialDrafts[q.id] || '')}>提交凭证</button>
          </label>
        ) : (
          <p key={q.id || q.question}>{q.question}</p>
        ),
      )}
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
