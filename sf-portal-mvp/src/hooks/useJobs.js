import { useState, useEffect, useCallback, useRef } from 'react'
import { factoryApi } from '../api/client'
import { subscribeFactoryEvents } from '../api/events'
import { selectDisplayJob } from './jobSelection'
import {
  appendExecutionRecord,
  recordsForAttempt,
  unreadCountForStep,
} from './executionRecordState'

// Debounce window (ms) for SSE-gap / onError / visibility snapshot resync.
// A burst of records must not hammer the summary endpoint.
const RESYNC_DEBOUNCE_MS = 400

export function useJobs() {
  const [jobs, setJobs] = useState([])
  const [activeJob, setActiveJob] = useState(null)
  const [steps, setSteps] = useState([])
  // Per-step snapshot: latest attempt + latest record (from execution-summary).
  const [summary, setSummary] = useState([])
  // Detail records (paginated per step+attempt), keyed by `${stepId}::${attempt}`.
  // Loaded ONLY when the drawer opens for a step+attempt — never on first load.
  const [recordsByStepAttempt, setRecordsByStepAttempt] = useState({})
  // Streaming records accumulator: the SSE tail for the currently-open
  // step+attempt(s). Kept separate from the paged REST pages so paging older
  // content doesn't fight the live tail. Flattened at read time by
  // `getRecords(stepId, attempt)`.
  const [streamRecords, setStreamRecords] = useState([])
  const [artifacts, setArtifacts] = useState([])
  // Collaboration plan (lanes + agents + edges) for the active job, when one
  // exists. Null for legacy jobs without a plan.
  const [collaborationPlan, setCollaborationPlan] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // --- Local-to-selected-task-view state (constraint #4) -------------------
  // The selected step/attempt drives the drawer. Unread tracking is scoped to
  // the selected task view: a new active step's records increment THAT card's
  // unread count WITHOUT replacing the currently-selected card/view.
  const [selectedStepId, setSelectedStepId] = useState(null)
  const [selectedAttempt, setSelectedAttempt] = useState(null)
  // Map `${stepId}::${attempt}` -> last sequence the user has "seen"
  // (drawer opened / card focused). Used for unread badges.
  const [lastReadByStepAttempt, setLastReadByStepAttempt] = useState({})

  const mountedRef = useRef(true)
  const jobsRef = useRef([])
  // Last SSE envelope `seq` we processed. Gap detection (constraint #9).
  const lastSeqRef = useRef(0)
  // Debounce timer handle for snapshot resync.
  const resyncTimerRef = useRef(null)
  // Track which job we're hydrated against so SSE for other jobs is ignored.
  const activeJobIdRef = useRef(null)
  // The centre task panel is selected by the current dialogue, not by a
  // process-wide "latest job". Null intentionally means that the selected
  // dialogue has no task to display (for example a brand-new dialogue).
  const selectedJobIdRef = useRef(null)
  const focusSelectionSetRef = useRef(false)

  const clearActiveJob = useCallback(() => {
    activeJobIdRef.current = null
    setActiveJob(null)
    setSteps([])
    setSummary([])
    setArtifacts([])
    setSelectedStepId(null)
    setSelectedAttempt(null)
    setRecordsByStepAttempt({})
    setStreamRecords([])
    setLastReadByStepAttempt({})
    setCollaborationPlan(null)
  }, [])

  const hydrateJob = useCallback(async job => {
    if (!job) {
      clearActiveJob()
      return
    }
    const jobId = job.id
    activeJobIdRef.current = jobId
    setActiveJob(job)
    setSelectedStepId(null)
    setSelectedAttempt(null)
    setRecordsByStepAttempt({})
    setStreamRecords([])
    setLastReadByStepAttempt({})

    const [stepsData, summaryData, artifactsData, planData] = await Promise.all([
      factoryApi.getJobSteps(jobId).catch(() => []),
      factoryApi.getJobExecutionSummary(jobId).catch(() => []),
      factoryApi.getJobArtifacts(jobId).catch(() => []),
      factoryApi.getJobCollaborationPlan(jobId).catch(() => null),
    ])
    // A history-dialogue switch may have selected another task while the old
    // request was in flight. Never paint the old job's details into the new
    // dialogue's task panel.
    if (!mountedRef.current || activeJobIdRef.current !== jobId) return
    const stepsList = Array.isArray(stepsData) ? stepsData : stepsData.steps || []
    setSteps(stepsList)
    setSummary(Array.isArray(summaryData) ? summaryData : summaryData.steps || [])
    const arts = Array.isArray(artifactsData) ? artifactsData : artifactsData.artifacts || []
    setArtifacts(arts)
    setCollaborationPlan(planData || null)
  }, [clearActiveJob])

  // -------------------------------------------------------------------------
  // Snapshot resync (constraint #9): re-fetch execution-summary + merge when
  // we may have missed SSE records. Triggered by: an envelope seq gap, an
  // EventSource onError, or the page becoming visible again. Debounced so a
  // burst doesn't hammer the API.
  // -------------------------------------------------------------------------
  // Fetch the full active-job snapshot (jobs + steps + summary + artifacts)
  // WITHOUT touching loading/error UI state. Used by both `refresh()` (which
  // wraps it in loading/error) and `scheduleResync()` (best-effort). Factored
  // out so a missed `step.updated` during a disconnect also refreshes step
  // status, not just the summary.
  const fetchSnapshot = useCallback(async () => {
    const data = await factoryApi.listJobs()
    const list = Array.isArray(data) ? data : data.jobs || []
    if (!mountedRef.current) return
    jobsRef.current = list
    setJobs(list)

    const selectedJobId = selectedJobIdRef.current
    const active = focusSelectionSetRef.current
      ? list.find(job => job.id === selectedJobId)
      : selectDisplayJob(list)
    await hydrateJob(active || null)
  }, [hydrateJob])

  // Called by App whenever the selected dialogue's focus task changes. The
  // task details and all task actions are consequently scoped to that dialogue.
  const selectJob = useCallback(async jobId => {
    focusSelectionSetRef.current = true
    selectedJobIdRef.current = jobId || null
    if (!jobId) {
      clearActiveJob()
      return
    }
    const job = jobsRef.current.find(item => item.id === jobId)
    if (job) {
      await hydrateJob(job)
      return
    }
    // The focus selector can run before the first list snapshot settles.
    // Refresh instead of falling back to a job from another dialogue.
    await fetchSnapshot()
  }, [clearActiveJob, fetchSnapshot, hydrateJob])

  const scheduleResync = useCallback(() => {
    if (resyncTimerRef.current != null) return
    resyncTimerRef.current = setTimeout(() => {
      resyncTimerRef.current = null
      const jobId = activeJobIdRef.current
      if (!jobId || !mountedRef.current) return
      // Full snapshot: a missed `step.updated` (status change) must also be
      // recovered, not just the summary. Best-effort — do NOT surface
      // transient errors as the main error state (SSE will retry on its own).
      fetchSnapshot().catch(() => {
        /* best-effort */
      })
    }, RESYNC_DEBOUNCE_MS)
  }, [fetchSnapshot])

  // Hydrate the summary + steps + artifacts for the active job, together.
  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      await fetchSnapshot()
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [fetchSnapshot])

  // -------------------------------------------------------------------------
  // Paginated detail load (constraint #10). NOT called on first load — only
  // when the drawer opens for a step+attempt, or the user pages older.
  // -------------------------------------------------------------------------
  const loadStepRecords = useCallback(async (stepId, attempt, beforeSequence) => {
    const jobId = activeJobIdRef.current
    if (!jobId || !stepId || attempt == null) return
    try {
      const data = await factoryApi.getStepExecutionRecords(jobId, stepId, attempt, beforeSequence)
      const page = Array.isArray(data) ? data : data.records || []
      if (!mountedRef.current) return
      const key = `${stepId}::${attempt}`
      setRecordsByStepAttempt(prev => {
        if (!beforeSequence) {
          // Newest page (drawer just opened): replace.
          return { ...prev, [key]: page }
        }
        // Older page: prepend (records are ascending sequence; older page
        // has smaller sequences).
        const existing = prev[key] || []
        const seen = new Set(existing.map(r => r.id))
        const merged = [...page.filter(r => !seen.has(r.id)), ...existing]
        return { ...prev, [key]: merged }
      })
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
    }
  }, [])

  // Open the drawer for a step+attempt: load newest page + mark read.
  const selectStepAttempt = useCallback(
    (stepId, attempt) => {
      setSelectedStepId(stepId)
      setSelectedAttempt(attempt)
      if (!stepId || attempt == null) return
      const key = `${stepId}::${attempt}`
      // Mark read up to the current latest known sequence for this pair so the
      // unread badge clears once the user opens the drawer.
      setStreamRecords(prev => {
        const maxSeq = recordsForAttempt(prev, stepId, attempt).reduce(
          (m, r) => Math.max(m, r.sequence || 0),
          0,
        )
        setLastReadByStepAttempt(read => ({ ...read, [key]: Math.max(read[key] || 0, maxSeq) }))
        return prev
      })
      loadStepRecords(stepId, attempt, 0)
    },
    [loadStepRecords],
  )

  const createJob = useCallback(
    async prompt => {
      setError(null)
      try {
        await factoryApi.createJob(prompt)
        await refresh()
      } catch (err) {
        setError(err.message || String(err))
        throw err
      }
    },
    [refresh],
  )

  const cancelJob = useCallback(
    async id => {
      setError(null)
      try {
        await factoryApi.cancelJob(id)
        await refresh()
      } catch (err) {
        setError(err.message || String(err))
      }
    },
    [refresh],
  )

  const retryCurrentStep = useCallback(
    async id => {
      setError(null)
      try {
        await factoryApi.retryCurrentStep(id)
        await refresh()
      } catch (err) {
        setError(err.message || String(err))
      }
    },
    [refresh],
  )

  const repairFromFailure = useCallback(
    async id => {
      setError(null)
      try {
        await factoryApi.repairFromFailure(id)
        await refresh()
      } catch (err) {
        setError(err.message || String(err))
      }
    },
    [refresh],
  )

  // saveStepSnapshot overwrites the per-task snapshot (job_steps.snapshot_json)
  // for ONE step. Edits ONLY this generation task's copy; the global
  // agents/skills registry is never touched. refresh() re-reads steps so the
  // drawer reflects the persisted snapshot.
  const saveStepSnapshot = useCallback(
    async (jobId, stepId, snapshot) => {
      setError(null)
      try {
        await factoryApi.patchJobStepSnapshot(jobId, stepId, snapshot)
        await refresh()
      } catch (err) {
        setError(err.message || String(err))
        throw err
      }
    },
    [refresh],
  )

  const answerJob = useCallback(
    async (id, answer) => {
      setError(null)
      try {
        await factoryApi.answerJob(id, answer)
        await refresh()
      } catch (err) {
        setError(err.message || String(err))
        throw err
      }
    },
    [refresh],
  )

  // -------------------------------------------------------------------------
  // SSE subscription: merge step.record.appended by id, track envelope seq for
  // gap detection, and schedule a debounced resync on gap / error / visibility.
  // -------------------------------------------------------------------------
  useEffect(() => {
    mountedRef.current = true
    refresh()

    const onEvent = (type, envelope) => {
      if (!mountedRef.current) return

      // Unwrap the server.Event envelope {seq,type,data,at}. For
      // step.record.appended the inner `data` is the record object.
      const isEnvelope = envelope && typeof envelope === 'object' && 'seq' in envelope
      const seq = isEnvelope ? Number(envelope.seq) : 0
      const payload = isEnvelope ? envelope.data : envelope

      // Gap detection (constraint #9): if we see a seq that skips, resync.
      if (isEnvelope && Number.isFinite(seq) && seq > 0) {
        if (lastSeqRef.current > 0 && seq > lastSeqRef.current + 1) {
          scheduleResync()
        }
        if (seq > lastSeqRef.current) lastSeqRef.current = seq
      }

      if (type === 'step.record.appended' && payload && payload.id) {
        const record = payload
        // Only track records for the active job (the SSE bus is shared).
        const jobId = activeJobIdRef.current
        if (record.job_id && jobId && record.job_id !== jobId) return
        setStreamRecords(prev => appendExecutionRecord(prev, record))
        return
      }

      if (type === 'job.created' || type === 'job.updated' || type === 'step.updated' || type === 'artifact.created') {
        refresh()
      }
    }

    const unsubscribe = subscribeFactoryEvents(onEvent, {
      onError: () => scheduleResync(),
    })

    const onVisibility = () => {
      if (document.visibilityState === 'visible') scheduleResync()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      mountedRef.current = false
      unsubscribe()
      document.removeEventListener('visibilitychange', onVisibility)
      if (resyncTimerRef.current != null) {
        clearTimeout(resyncTimerRef.current)
        resyncTimerRef.current = null
      }
    }
  }, [refresh, scheduleResync])

  // -------------------------------------------------------------------------
  // Read helpers for consumers (Task 6 will render six cards + the drawer).
  // -------------------------------------------------------------------------

  // Flatten REST page + streaming tail for a step+attempt, deduped by id and
  // sorted ascending by sequence. This is the view the drawer renders.
  const getRecords = useCallback(
    (stepId, attempt) => {
      if (!stepId || attempt == null) return []
      const key = `${stepId}::${attempt}`
      const paged = recordsByStepAttempt[key] || []
      const streamed = recordsForAttempt(streamRecords, stepId, attempt)
      const seen = new Set(paged.map(r => r.id))
      const merged = [...paged, ...streamed.filter(r => !seen.has(r.id))]
      return merged.sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
    },
    [recordsByStepAttempt, streamRecords],
  )

  const getUnreadCount = useCallback(
    (stepId, attempt) => {
      if (!stepId || attempt == null) return 0
      const key = `${stepId}::${attempt}`
      const lastRead = lastReadByStepAttempt[key] || 0
      // Unread is computed against the streaming tail (live deltas), so a new
      // active step's records bump ITS card badge without touching the
      // currently-selected card.
      return unreadCountForStep(streamRecords, stepId, attempt, lastRead)
    },
    [lastReadByStepAttempt, streamRecords],
  )

  return {
    jobs,
    activeJob,
    steps,
    summary,
    artifacts,
    collaborationPlan,
    loading,
    error,
    refresh,
    selectJob,
    createJob,
    cancelJob,
    answerJob,
    retryCurrentStep,
    repairFromFailure,
    saveStepSnapshot,
    // New (Task 5):
    selectedStepId,
    selectedAttempt,
    selectStepAttempt,
    loadStepRecords,
    getRecords,
    getUnreadCount,
  }
}
