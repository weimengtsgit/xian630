import { ChevronDown, ChevronRight, FileText, MonitorCheck } from 'lucide-react'
import { useState } from 'react'
import { WorkbenchTrack } from './WorkbenchTracks'

const CONFIRM_LABEL = {
  business_logic: '确认业务逻辑并继续',
  interface_parsing: '确认界面解析并继续',
  data_capture: '确认数据抓取并继续',
}

export function WorkbenchAgentBlock({
  card,
  thinking,
  analysisLog,
  questions = [],
  prototype,
  onConfirm,
  onOpenArtifact,
  onSubmitCredential,
  onOpenPrototype,
  onPrototypeFeedback,
  onConfirmPrototype,
  onContinuePrototype,
}) {
  const [open, setOpen] = useState(!isFolded(card))
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
  return (
    <section className={`cw-agent-block cw-agent-block-${card.key} ${open ? 'is-open' : 'is-folded'}`}>
      <button type="button" className="cw-agent-block-head" onClick={() => setOpen(v => !v)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <strong>{card.label}</strong>
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
          {prototype ? (
            <section className="cw-agent-section cw-prototype-card">
              <h4>原型预览</h4>
              <p>{prototype.label} · {prototype.fidelity} · 默认页：{prototype.defaultPage}</p>
              {prototype.pageLabels.length ? <p>页面清单：{prototype.pageLabels.join(' / ')}</p> : null}
              <div className="cw-prototype-actions">
                <button type="button" onClick={() => onOpenPrototype && onOpenPrototype(prototype)}>打开预览</button>
                <button type="button" onClick={() => onPrototypeFeedback && onPrototypeFeedback(prototype)}>提出修改</button>
                {prototype.canConfirm ? <button type="button" onClick={() => onConfirmPrototype && onConfirmPrototype(prototype)}>确认原型并继续</button> : null}
                {prototype.canContinue ? <button type="button" onClick={() => onContinuePrototype && onContinuePrototype(prototype)}>直接进入方案设计</button> : null}
              </div>
            </section>
          ) : null}
          {canConfirm ? <button type="button" className="cw-agent-confirm" onClick={() => onConfirm && onConfirm(card.key)}>{CONFIRM_LABEL[card.key]}</button> : null}
        </div>
      ) : (
        <div className="cw-agent-folded">
          {previewableArtifacts.map(item => <button key={item.id || item.path} type="button" onClick={() => onOpenArtifact && onOpenArtifact(item)}>{item.label || item.path}</button>)}
        </div>
      )}
    </section>
  )
}

function isPreviewableArtifact(item) {
  if (!item) return false
  return item.kind === 'interface_preview' || !!item.path || !!item.previewUrl
}

function isFolded(card) {
  return card.state === 'confirmed' || card.state === 'delivered'
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
