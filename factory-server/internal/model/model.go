package model

import "time"

type AppSource string

const (
	AppSourcePreset    AppSource = "preset"
	AppSourceGenerated AppSource = "generated"
)

type AppStatus string

const (
	AppStatusStopped  AppStatus = "stopped"
	AppStatusRunning  AppStatus = "running"
	AppStatusError    AppStatus = "error"
	AppStatusBuilding AppStatus = "building"
	AppStatusMissing  AppStatus = "missing"
)

// ApplicationVersionStatus is the lifecycle state of a single application
// version in its lineage. The string value is persisted verbatim into the
// application_versions.status column.
type ApplicationVersionStatus string

const (
	// ApplicationVersionQueued is the initial state of a version whose build
	// job has not started yet.
	ApplicationVersionQueued ApplicationVersionStatus = "queued"
	// ApplicationVersionBuilding is a version whose job is currently running.
	ApplicationVersionBuilding ApplicationVersionStatus = "building"
	// ApplicationVersionFailed is a version whose job ended without producing
	// a deployable result; it is never promoted.
	ApplicationVersionFailed ApplicationVersionStatus = "failed"
	// ApplicationVersionEffective is the single currently-served version of an
	// application; at most one version per app is effective at a time.
	ApplicationVersionEffective ApplicationVersionStatus = "effective"
	// ApplicationVersionSuperseded is a formerly-effective version that a newer
	// promotion has replaced.
	ApplicationVersionSuperseded ApplicationVersionStatus = "superseded"
)

// ApplicationVersion is one immutable entry in an application's version
// lineage: the job that produced it, the parent version it was built from, the
// artifact path it serves, and (once promoted) the deployment it resolved to.
// The lineage is strictly ordered by CreatedAt; ParentVersionID links each
// version to its baseline. The UNIQUE(job_id) constraint enforces one version
// per job.
type ApplicationVersion struct {
	ID              string                  `json:"id"`
	ApplicationID   string                  `json:"application_id"`
	ParentVersionID string                  `json:"parent_version_id,omitempty"`
	JobID           string                  `json:"job_id"`
	Status          ApplicationVersionStatus `json:"status"`
	SourcePath      string                  `json:"source_path,omitempty"`
	DeploymentID    string                  `json:"deployment_id,omitempty"`
	CreatedAt       time.Time               `json:"created_at"`
	// PromotedAt is set when (and only when) the version becomes Effective; it
	// is nil for queued/building/failed/superseded versions.
	PromotedAt *time.Time `json:"promoted_at,omitempty"`
}

type JobStatus string

const (
	JobStatusDraft       JobStatus = "draft"
	JobStatusQueued      JobStatus = "queued"
	JobStatusRunning     JobStatus = "running"
	JobStatusWaitingUser JobStatus = "waiting_user"
	JobStatusFailed      JobStatus = "failed"
	JobStatusCompleted   JobStatus = "completed"
	JobStatusCanceled    JobStatus = "canceled"
)

type StepKind string

const (
	StepRequirementAnalysis StepKind = "requirement_analysis"
	StepSolutionDesign      StepKind = "solution_design"
	StepCodeGeneration      StepKind = "code_generation"
	StepTestVerification    StepKind = "test_verification"
	StepImageBuild          StepKind = "image_build"
	StepDeployment          StepKind = "deployment"
)

type StepStatus string

const (
	StepStatusPending     StepStatus = "pending"
	StepStatusRunning     StepStatus = "running"
	StepStatusWaitingUser StepStatus = "waiting_user"
	StepStatusSucceeded   StepStatus = "succeeded"
	StepStatusFailed      StepStatus = "failed"
	StepStatusSkipped     StepStatus = "skipped"
	StepStatusCanceled    StepStatus = "canceled"
)

type ErrorCode string

const (
	ErrorRunnerExitNonzero                ErrorCode = "runner_exit_nonzero"
	ErrorRunnerTimeout                    ErrorCode = "runner_timeout"
	ErrorOutputMissing                    ErrorCode = "output_missing"
	ErrorOutputInvalidJSON                ErrorCode = "output_invalid_json"
	ErrorSchemaValidationFailed           ErrorCode = "schema_validation_failed"
	ErrorFileConstraintViolated           ErrorCode = "file_constraint_violated"
	ErrorDependencyInstallFailed          ErrorCode = "dependency_install_failed"
	ErrorBuildFailed                      ErrorCode = "build_failed"
	ErrorImageBuildFailed                 ErrorCode = "image_build_failed"
	ErrorPodmanRunFailed                  ErrorCode = "podman_run_failed"
	ErrorPortUnavailable                  ErrorCode = "port_unavailable"
	ErrorHealthCheckFailed                ErrorCode = "health_check_failed"
	ErrorCCStatusUnavailable              ErrorCode = "cc_status_unavailable"
	ErrorCanceled                         ErrorCode = "canceled"
	ErrorExecutionRecordPersistenceFailed ErrorCode = "execution_record_persistence_failed"
	ErrorUnknown                          ErrorCode = "unknown"
)

// ExecutionRecordKind is the kind tag of a StepExecutionRecord: system
// lifecycle events, per-step activity/summaries, captured command stdout/stderr,
// or errors. The string value is persisted verbatim into the
// step_execution_records.kind column.
type ExecutionRecordKind string

const (
	ExecutionRecordSystem        ExecutionRecordKind = "system"
	ExecutionRecordActivity      ExecutionRecordKind = "activity"
	ExecutionRecordSummary       ExecutionRecordKind = "summary"
	ExecutionRecordCommandStdout ExecutionRecordKind = "command_stdout"
	ExecutionRecordCommandStderr ExecutionRecordKind = "command_stderr"
	ExecutionRecordError         ExecutionRecordKind = "error"
	// ExecutionRecordThinking carries the model's reasoning/thinking (方案 B:
	// constraint #5 is relaxed so hidden reasoning IS shown). It still passes
	// through the stepEmitter redaction chokepoint, so any credential echoed in
	// a thought is masked before persist+SSE. Chunked to ≤4 KiB per record.
	ExecutionRecordThinking ExecutionRecordKind = "thinking"
	// ExecutionRecordFileDelta carries a single file's generation delta during
	// code_generation: which file was Written/Edited and the +added/-removed line
	// counts, so the drawer can show the live "agent writing src/App.jsx (+142)"
	// progress like Claude Code / Codex. Computed from the Edit/Write tool_use
	// input (content / old_string / new_string).
	ExecutionRecordFileDelta ExecutionRecordKind = "file_delta"
)

// StepExecutionRecord is one durable, immutable line of a step's audit trail:
// a stdout chunk, a lifecycle event, a summary blob, etc. Sequence is per
// (step_id, attempt) and assigned by the executor-side reporter, never by the
// browser or the store. The store enforces UNIQUE(step_id, attempt, sequence).
type StepExecutionRecord struct {
	ID        string              `json:"id"`
	JobID     string              `json:"job_id"`
	StepID    string              `json:"step_id"`
	Attempt   int                 `json:"attempt"`
	Sequence  int                 `json:"sequence"`
	Kind      ExecutionRecordKind `json:"kind"`
	Content   string              `json:"content"`
	Truncated bool                `json:"truncated"`
	CreatedAt time.Time           `json:"created_at"`
}

// StepExecutionSummary is the per-step rollup returned by
// ListStepExecutionSummaries: the latest attempt number for the step plus a
// pointer to the highest-sequence record within that latest attempt. It is the
// shape the portal renders in a step card's "last activity" slot.
type StepExecutionSummary struct {
	StepID        string               `json:"step_id"`
	LatestAttempt int                  `json:"latest_attempt"`
	LatestRecord  *StepExecutionRecord `json:"latest_record,omitempty"`
}

type Application struct {
	ID           string    `json:"id"`
	Slug         string    `json:"slug"`
	Name         string    `json:"name"`
	Type         string    `json:"type"`
	Source       AppSource `json:"source"`
	Description  string    `json:"description"`
	Path         string    `json:"path"`
	ManifestPath string    `json:"manifest_path"`
	Status       AppStatus `json:"status"`
	RuntimeURL   string    `json:"runtime_url,omitempty"`
	// DisplayOrder is the catalog-assigned display position for application-
	// surface presets (from .factory/scene-catalog.json). Generated applications
	// and non-application presets retain 0.
	DisplayOrder int       `json:"display_order"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// AgentCategory partitions agents by how they are produced: the six fixed
// software-development pipeline agents (registry-seeded, kind-driven) versus
// business-processing agents created from a confirmed dialogue.
type AgentCategory string

const (
	// AgentCategorySoftwareDevelopment is the category for the six pipeline
	// agents (requirement_analysis … deployment). They are registry-seeded and
	// dispatched by StepKind; a manually-created agent cannot claim it.
	AgentCategorySoftwareDevelopment AgentCategory = "software_development"
	// AgentCategoryBusinessProcessing is the category for agents produced from
	// a confirmed business-processing dialogue. They carry a non-empty Prompt.
	AgentCategoryBusinessProcessing AgentCategory = "business_processing"
)

type Agent struct {
	ID              string `json:"id"`
	Key             string `json:"key"`
	Name            string `json:"name"`
	Role            string `json:"role"`
	Description     string `json:"description"`
	ClaudeAgentName string `json:"claude_agent_name"`
	SkillsJSON      string `json:"skills_json"`
	// Category is software_development (pipeline) or business_processing
	// (dialogue-created). See AgentCategory.
	Category AgentCategory `json:"category"`
	// Prompt is the system prompt for a business_processing agent. Empty for
	// the six software-development pipeline agents.
	Prompt    string `json:"prompt"`
	Enabled   bool   `json:"enabled"`
	SortOrder int    `json:"sort_order"`
}

type Job struct {
	ID               string    `json:"id"`
	UserPrompt       string    `json:"user_prompt"`
	NormalizedPrompt string    `json:"normalized_prompt"`
	AppSlug          string    `json:"app_slug"`
	AppName          string    `json:"app_name"`
	Status           JobStatus `json:"status"`
	CurrentStepKind  StepKind  `json:"current_step_kind"`
	CreatedAppID     string    `json:"created_app_id,omitempty"`
	LockOwner        string    `json:"lock_owner,omitempty"`
	// ClarificationSessionID links the job to the pre-job clarification session
	// whose confirmed requirement produced this job. Empty for legacy/direct
	// creates (the direct create path now requires a confirmed requirement, so
	// non-legacy jobs always carry a session id).
	ClarificationSessionID string `json:"clarification_session_id,omitempty"`
	// ConfirmedRequirementJSON is the frozen, server-finalized requirement the
	// requirement_analysis step audits (it no longer clarifies). Empty for legacy
	// jobs; the requirement_analysis step guards the empty case by substituting {}.
	ConfirmedRequirementJSON string     `json:"confirmed_requirement_json,omitempty"`
	CreatedAt                time.Time  `json:"created_at"`
	StartedAt                *time.Time `json:"started_at,omitempty"`
	EndedAt                  *time.Time `json:"ended_at,omitempty"`
	UpdatedAt                time.Time  `json:"updated_at"`
}

type JobStep struct {
	ID                string     `json:"id"`
	JobID             string     `json:"job_id"`
	Kind              StepKind   `json:"kind"`
	Seq               int        `json:"seq"`
	AgentKey          string     `json:"agent_key"`
	Status            StepStatus `json:"status"`
	Attempt           int        `json:"attempt"`
	StartedAt         *time.Time `json:"started_at,omitempty"`
	EndedAt           *time.Time `json:"ended_at,omitempty"`
	NeedsUserInput    bool       `json:"needs_user_input"`
	UserPrompt        string     `json:"user_prompt,omitempty"`
	ErrorCode         ErrorCode  `json:"error_code,omitempty"`
	ErrorMessage      string     `json:"error_message,omitempty"`
	ClaudeSessionID   string     `json:"claude_session_id,omitempty"`
	CCStatusSessionID string     `json:"cc_status_session_id,omitempty"`
}

// Artifact is a single output produced by a job step: a requirements doc, a
// design doc, generated source, a test report, an image, etc. The Path points
// at a file inside the configured artifact root (see design §7).
type Artifact struct {
	ID        string    `json:"id"`
	JobID     string    `json:"job_id"`
	StepID    string    `json:"step_id"`
	Attempt   int       `json:"attempt"`
	Kind      string    `json:"kind"`
	Path      string    `json:"path"`
	Summary   string    `json:"summary"`
	CreatedAt time.Time `json:"created_at"`
}

// Deployment is one run of an application as a Podman container: the image
// that was built, the container name, the host:container port mapping, the
// serving URL and the lifecycle status (running|stopped|failed). See design §7.6.
type Deployment struct {
	ID            string     `json:"id"`
	AppID         string     `json:"app_id"`
	JobID         string     `json:"job_id,omitempty"`
	ImageName     string     `json:"image_name"`
	ImageTag      string     `json:"image_tag"`
	ContainerName string     `json:"container_name"`
	HostPort      int        `json:"host_port"`
	ContainerPort int        `json:"container_port"`
	URL           string     `json:"url"`
	Status        string     `json:"status"` // running|stopped|failed
	CreatedAt     time.Time  `json:"created_at"`
	StartedAt     *time.Time `json:"started_at,omitempty"`
	StoppedAt     *time.Time `json:"stopped_at,omitempty"`
}

// ConversationMessage is one entry in the multi-turn conversation thread tied to
// a job. The JobID is empty for the global/system thread.
type ConversationMessage struct {
	ID           string    `json:"id"`
	JobID        string    `json:"job_id,omitempty"`
	Role         string    `json:"role"`
	Content      string    `json:"content"`
	MetadataJSON string    `json:"metadata_json,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
}

// ClarificationStatus is the lifecycle state of a clarification session: it
// moves active -> waiting_user -> ready_to_confirm -> confirmed, or detours to
// failed / abandoned.
type ClarificationStatus string

const (
	ClarificationStatusActive         ClarificationStatus = "active"
	ClarificationStatusWaitingUser    ClarificationStatus = "waiting_user"
	ClarificationStatusReadyToConfirm ClarificationStatus = "ready_to_confirm"
	ClarificationStatusConfirmed      ClarificationStatus = "confirmed"
	ClarificationStatusFailed         ClarificationStatus = "failed"
	ClarificationStatusAbandoned      ClarificationStatus = "abandoned"
)

// ClarificationSession is one multi-round requirement-clarification exchange
// that runs before a Job is created. RequirementJSON holds the evolving
// structured requirement; CreatedJobID is set once the session produces a Job.
type ClarificationSession struct {
	ID              string              `json:"id"`
	Status          ClarificationStatus `json:"status"`
	InitialPrompt   string              `json:"initial_prompt"`
	Round           int                 `json:"round"`
	MaxRounds       int                 `json:"max_rounds"`
	RequirementJSON string              `json:"requirement_json"`
	CreatedJobID    string              `json:"created_job_id,omitempty"`
	ErrorCode       string              `json:"error_code,omitempty"`
	ErrorMessage    string              `json:"error_message,omitempty"`
	CreatedAt       time.Time           `json:"created_at"`
	UpdatedAt       time.Time           `json:"updated_at"`
	ConfirmedAt     *time.Time          `json:"confirmed_at,omitempty"`
	AbandonedAt     *time.Time          `json:"abandoned_at,omitempty"`
}

// ClarificationMessage is one entry in a clarification session's message
// thread: an agent analysis/work-log, a user question/answer, etc.
type ClarificationMessage struct {
	ID           string    `json:"id"`
	SessionID    string    `json:"session_id"`
	Role         string    `json:"role"`
	Kind         string    `json:"kind"`
	Content      string    `json:"content"`
	MetadataJSON string    `json:"metadata_json,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
}

// DialogueIntent is the high-level outcome the user wants from a dialogue:
// reuse an existing application, generate a new one, or create a
// business-processing agent. The string value is persisted verbatim.
type DialogueIntent string

const (
	// DialogueIntentRouting is the transient pre-route intent before the
	// dialogue's recommendation has locked a route.
	DialogueIntentRouting                 DialogueIntent = "routing"
	DialogueIntentExistingApplication     DialogueIntent = "existing_application"
	DialogueIntentApplicationGeneration   DialogueIntent = "application_generation"
	DialogueIntentBusinessProcessingAgent DialogueIntent = "business_processing_agent"
)

// DialogueStatus is the lifecycle state of a dialogue session. A fresh dialogue
// starts in routing, then transitions through the route/clarification/drafting
// phases. Once its first application is resolved (or an existing app is opened)
// it becomes a CONTINUING session that stays open for follow-up turns: active,
// analyzing, waiting_user, change_confirmation, task_running, and (eventually)
// archived. The terminal-only states resolved/failed/abandoned are retained for
// legacy rows and the dormant business-agent flow.
type DialogueStatus string

const (
	DialogueStatusRouting               DialogueStatus = "routing"
	DialogueStatusRecommending          DialogueStatus = "recommending"
	DialogueStatusDraftingApplication   DialogueStatus = "drafting_application"
	DialogueStatusDraftingBusinessAgent DialogueStatus = "drafting_business_agent"
	DialogueStatusResolved              DialogueStatus = "resolved"
	DialogueStatusFailed                DialogueStatus = "failed"
	DialogueStatusAbandoned             DialogueStatus = "abandoned"
	// Continuing-session phases (Task 2). A resolved/opened dialogue backfills to
	// active and stays open so the user can send follow-up messages; each message
	// is analyzed as a turn rather than re-routing the whole session.
	DialogueStatusActive             DialogueStatus = "active"
	DialogueStatusAnalyzing          DialogueStatus = "analyzing"
	DialogueStatusWaitingUser        DialogueStatus = "waiting_user"
	DialogueStatusChangeConfirmation DialogueStatus = "change_confirmation"
	DialogueStatusTaskRunning        DialogueStatus = "task_running"
	DialogueStatusArchived           DialogueStatus = "archived"
)

// IsContinuingDialogueStatus reports whether a status belongs to a continuing
// (open) dialogue session — one whose session route is already established and
// that accepts follow-up turns via POST .../messages. The pre-route routing
// status and the legacy terminal states are NOT continuing.
func IsContinuingDialogueStatus(s DialogueStatus) bool {
	switch s {
	case DialogueStatusActive,
		DialogueStatusAnalyzing,
		DialogueStatusWaitingUser,
		DialogueStatusChangeConfirmation,
		DialogueStatusTaskRunning:
		return true
	}
	return false
}

// DialogueSession is the durable parent of a multi-turn dialogue that routes a
// user request to one of the three Factory outcomes (existing app, generated
// app, or business-processing agent). DraftJSON holds the in-progress route
// recommendation/draft payload (existing-app cards, agent draft, etc.) as a
// JSON string. ClarificationSessionID links the legacy pre-job clarification
// session that seeded this dialogue (set by the idempotent startup backfill;
// empty for dialogues created by the new routes).
type DialogueSession struct {
	ID                     string         `json:"id"`
	InitialPrompt          string         `json:"initial_prompt"`
	DraftJSON              string         `json:"draft_json,omitempty"`
	ErrorCode              string         `json:"error_code,omitempty"`
	ErrorMessage           string         `json:"error_message,omitempty"`
	Status                 DialogueStatus `json:"status"`
	Intent                 DialogueIntent `json:"intent"`
	RouteLocked            bool           `json:"route_locked"`
	ClarificationSessionID string         `json:"clarification_session_id,omitempty"`
	ResolvedApplicationID  string         `json:"resolved_application_id,omitempty"`
	CreatedAgentID         string         `json:"created_agent_id,omitempty"`
	CreatedAt              time.Time      `json:"created_at"`
	UpdatedAt              time.Time      `json:"updated_at"`
	ResolvedAt             *time.Time     `json:"resolved_at,omitempty"`
	AbandonedAt            *time.Time     `json:"abandoned_at,omitempty"`
}

// DialogueMessage is one entry in a dialogue session's message thread: a route
// recommendation, a draft, a user answer, a system lifecycle event, etc.
type DialogueMessage struct {
	ID           string    `json:"id"`
	DialogueID   string    `json:"dialogue_id"`
	Role         string    `json:"role"`
	Kind         string    `json:"kind"`
	Content      string    `json:"content"`
	MetadataJSON string    `json:"metadata_json,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
}

// TurnIntent is the per-message user need inferred for one turn of a CONTINUING
// dialogue session (distinct from the one-time session route). It is exactly one
// of the five values below; anything else is rejected.
type TurnIntent string

const (
	// TurnIntentApplicationModification is a change to an application already
	// linked to the dialogue. The turn produces a change summary; after
	// confirmation a new application version is generated.
	TurnIntentApplicationModification TurnIntent = "application_modification"
	// TurnIntentNewApplication is a request for a distinct application. The turn
	// forks the dialogue: a new dialogue draft is created and dialogue.forked is
	// emitted.
	TurnIntentNewApplication TurnIntent = "new_application"
	// TurnIntentApplicationInquiry is a question about an existing application
	// that needs no generation job.
	TurnIntentApplicationInquiry TurnIntent = "application_inquiry"
	// TurnIntentTaskControl controls an in-flight generation task (cancel, retry).
	// It produces no new job.
	TurnIntentTaskControl TurnIntent = "task_control"
	// TurnIntentGeneralDialogue is conversational follow-up that needs no job.
	TurnIntentGeneralDialogue TurnIntent = "general_dialogue"
)

// ValidTurnIntent reports whether s is one of the five allowed turn intents.
func ValidTurnIntent(s string) bool {
	switch TurnIntent(s) {
	case TurnIntentApplicationModification,
		TurnIntentNewApplication,
		TurnIntentApplicationInquiry,
		TurnIntentTaskControl,
		TurnIntentGeneralDialogue:
		return true
	}
	return false
}

// TurnStatus is the lifecycle state of one analysis turn. A turn starts pending
// (queued behind an in-flight turn for the same dialogue), becomes running while
// the model analyzes it, and ends in a terminal state (completed/canceled/
// failed). At most one turn per dialogue is running at a time.
type TurnStatus string

const (
	TurnStatusPending   TurnStatus = "pending"
	TurnStatusRunning   TurnStatus = "running"
	TurnStatusCompleted TurnStatus = "completed"
	TurnStatusCanceled  TurnStatus = "canceled"
	TurnStatusFailed    TurnStatus = "failed"
)

// DialogueTurn is one per-message analysis round within a continuing dialogue
// session. It links the triggering user message to the inferred turn intent and
// its lifecycle. Created at message-accept time; the turn worker claims the
// oldest pending turn per dialogue, runs the turn-intent round, and marks it
// terminal before the next turn begins.
type DialogueTurn struct {
	ID         string     `json:"id"`
	DialogueID string     `json:"dialogue_id"`
	MessageID  string     `json:"message_id"`
	Intent     TurnIntent `json:"intent"`
	Status     TurnStatus `json:"status"`
	SummaryJSON string    `json:"summary_json,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
	StartedAt  *time.Time `json:"started_at,omitempty"`
	EndedAt    *time.Time `json:"ended_at,omitempty"`
}

// WorkTraceEvent is one durable, immutable, VISIBLE line of a dialogue's
// activity audit trail: an intent recognized, a tool used, data gathered, a
// validation result, a task status change, a warning/error. Sequence is per
// dialogue_id and assigned by the store (MAX+1 in one transaction, enforced by
// UNIQUE(dialogue_id, sequence)); the first event for a dialogue is sequence 1.
//
// SECURITY contract (Constraint #9): only allowlisted Type values may persist
// here, and the payload gate in the store rejects provider thinking/thinking
// deltas, raw request/response bodies, headers, credentials, and uncapped
// command output. PayloadJSON holds a producer-supplied, already-summarized/
// redacted JSON document (Task 4 produces safe payloads); the store enforces a
// byte cap and structural sensitive-key stripping as a defense-in-depth gate.
// NEVER reach this table with raw hidden reasoning — that must never leave the
// producer, and the gate rejects it if it does.
type WorkTraceEvent struct {
	ID           string    `json:"id"`
	DialogueID   string    `json:"dialogue_id"`
	Sequence     int64     `json:"sequence"`
	TaskID       string    `json:"task_id,omitempty"`
	ApplicationID string   `json:"application_id,omitempty"`
	VersionID    string    `json:"version_id,omitempty"`
	StepID       string    `json:"step_id,omitempty"`
	Attempt      int       `json:"attempt,omitempty"`
	Type         string    `json:"type"`
	PayloadJSON  string    `json:"payload_json"`
	CreatedAt    time.Time `json:"created_at"`
}

// WorkTraceType is the category of a visible work-trace event. Only values in
// the allowlist (see store.AllowedWorkTraceTypes) may persist or stream. The
// categories are the "what is happening the user may see" surface: reasoning
// surfacing (intent/approach/assumption/clarification), actions (tool/data),
// checks (validation), decisions (change confirmation), lifecycle (task/version/
// deployment), and signals (warning/error). Provider thinking and raw bodies are
// deliberately NOT categories — they are rejected before reaching the type.
type WorkTraceType string

const (
	WorkTraceIntent        WorkTraceType = "intent"        // recognized user intent surfaced
	WorkTraceApproach      WorkTraceType = "approach"      // chosen approach/plan surfaced
	WorkTraceAssumption    WorkTraceType = "assumption"    // stated assumption surfaced
	WorkTraceClarification WorkTraceType = "clarification" // clarification question/answer
	WorkTraceTool          WorkTraceType = "tool"          // tool action summary (not raw I/O)
	WorkTraceData          WorkTraceType = "data"          // data gathered/produced summary
	WorkTraceValidation    WorkTraceType = "validation"    // validation/check result
	WorkTraceChangeConfirm WorkTraceType = "change_confirmation" // proposed change awaiting user confirm
	WorkTraceTask          WorkTraceType = "task"          // task status transition
	WorkTraceVersion       WorkTraceType = "version"       // application version transition
	WorkTraceDeployment    WorkTraceType = "deployment"    // deployment transition
	WorkTraceWarning       WorkTraceType = "warning"       // non-fatal warning surfaced
	WorkTraceError         WorkTraceType = "error"         // error surfaced
	WorkTraceAssistant     WorkTraceType = "assistant_output" // assistant text output
)
