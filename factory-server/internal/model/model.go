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
	ID              string                   `json:"id"`
	ApplicationID   string                   `json:"application_id"`
	ParentVersionID string                   `json:"parent_version_id,omitempty"`
	JobID           string                   `json:"job_id"`
	Status          ApplicationVersionStatus `json:"status"`
	SourcePath      string                   `json:"source_path,omitempty"`
	DeploymentID    string                   `json:"deployment_id,omitempty"`
	CreatedAt       time.Time                `json:"created_at"`
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

	// Collaboration-pipeline step kinds. These are the dynamic-plan gates: the
	// first three are the early analysis/contract steps, and the last three are
	// the blocking review gates whose failures may trigger a bounded auto-repair
	// loop back to code_generation. They are NOT part of FixedSteps() (the legacy
	// six-step path), so legacy executor tests are unaffected; a job carrying a
	// CollaborationPlanJSON advances through its seeded steps by Seq order.
	StepCollaborationOrchestration StepKind = "collaboration_orchestration"
	StepDomainAnalysis             StepKind = "domain_analysis"
	StepDesignContract             StepKind = "design_contract"
	StepDataIntegration            StepKind = "data_integration"
	StepCodeReview                 StepKind = "code_review"
	StepSecurityReview             StepKind = "security_review"
	StepProductAcceptance          StepKind = "product_acceptance"
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
	// ErrorBlockingReview is the error code for a blocking review gate
	// (code_review / security_review / product_acceptance) whose agent output
	// returned status:"blocked". It is the only code a blocking-review failure
	// carries, and it is repairable under the bounded auto-repair policy.
	ErrorBlockingReview ErrorCode = "blocking_review"
	ErrorUnknown        ErrorCode = "unknown"
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
	// ExecutionRecordThinking carried the model's reasoning/thinking under the
	// earlier 方案 B policy. As of Task 4 it is RETAINED as a const for backward
	// compatibility but is NEVER produced: stream.go:emitStreamLine drops thinking
	// blocks at the source (Constraint #9 HARD SECURITY), so no thinking record is
	// ever emitted, persisted, or published over SSE. It remains defined only so
	// the string value stays stable for any historical consumer; no producer in
	// the runner or executor calls Emit with this kind.
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

// ApplicationGenerationStats is the app-store summary of generation duration.
// ApplicationAverageGenerationMs averages each application's first completed
// generation job. IterationAverageGenerationMs averages the latest completed
// job only for applications with more than one completed generation.
type ApplicationGenerationStats struct {
	ApplicationAverageGenerationMs *int64 `json:"application_average_generation_ms"`
	IterationAverageGenerationMs   *int64 `json:"iteration_average_generation_ms"`
	ApplicationSampleCount         int    `json:"application_sample_count"`
	IterationSampleCount           int    `json:"iteration_sample_count"`
}

// AgentCategory partitions agents by how they are produced: the registry-seeded
// software-development pipeline agents (kind-driven) versus business-processing
// agents created from a confirmed dialogue.
type AgentCategory string

const (
	// AgentCategorySoftwareDevelopment is the category for collaboration
	// pipeline agents. They are registry-seeded and dispatched by StepKind; a
	// manually-created agent cannot claim it.
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
	// software-development pipeline agents.
	Prompt    string `json:"prompt"`
	Enabled   bool   `json:"enabled"`
	SortOrder int    `json:"sort_order"`
	// CreatedAt is when the agent was generated (registry-seeded or created
	// from a dialogue). INTEGER unix ms at the store boundary; 0 for rows that
	// predate the column (the UI renders those as no time).
	CreatedAt time.Time `json:"created_at"`
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
	ConfirmedRequirementJSON string `json:"confirmed_requirement_json,omitempty"`
	// DialogueID links the job to the dialogue whose work-trace its safe agent
	// activity is surfaced under (Task 4). It is the sequence-partition key for
	// work_trace_events: every trace the executor emits is stamped with this id
	// so the dialogue-scoped SSE stream can filter it. Empty for legacy/direct
	// jobs with no dialogue link; the stepEmitter drops traces with an empty
	// dialogue id (no partition key) rather than emit an unattributable row.
	// Task 1 added the column; Task 4 surfaces it through the model + store.
	DialogueID string `json:"dialogue_id,omitempty"`
	// ApplicationID links the job to the application it produces (Task 5 wires
	// the value; Task 4 surfaces the field so CreateJob/scanJob read/write it).
	ApplicationID string `json:"application_id,omitempty"`
	// BaseVersionID is the version this job's application forks from, when it is
	// a revise/rebuild (Task 6). Empty for a fresh generation.
	BaseVersionID string `json:"base_version_id,omitempty"`
	// Kind is the job kind (e.g. "generate", "revise"). Reserved for later tasks;
	// surfaced now so the column is read/written rather than orphaned.
	Kind string `json:"kind,omitempty"`
	// CollaborationPlanJSON is the persisted, user-confirmed collaboration-agent
	// plan for this generation task. Empty means legacy fixed-step job.
	CollaborationPlanJSON string     `json:"collaboration_plan_json,omitempty"`
	CreatedAt             time.Time  `json:"created_at"`
	StartedAt             *time.Time `json:"started_at,omitempty"`
	EndedAt               *time.Time `json:"ended_at,omitempty"`
	UpdatedAt             time.Time  `json:"updated_at"`
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
	PendingQuestions  string     `json:"pending_questions,omitempty"`
	ErrorCode         ErrorCode  `json:"error_code,omitempty"`
	ErrorMessage      string     `json:"error_message,omitempty"`
	ClaudeSessionID   string     `json:"claude_session_id,omitempty"`
	CCStatusSessionID string     `json:"cc_status_session_id,omitempty"`
	// SnapshotJSON is the per-task collaboration-agent configuration snapshot
	// used by this step. Empty means legacy fixed-step behavior.
	SnapshotJSON string `json:"snapshot_json,omitempty"`
}

// JobStepEdge is one directed dependency edge between two job steps: ToStepID
// may only start after FromStepID has finished. The plan's topological order is
// the set of edges for a job.
type JobStepEdge struct {
	JobID      string `json:"job_id"`
	FromStepID string `json:"from_step_id"`
	ToStepID   string `json:"to_step_id"`
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
	ID                 string              `json:"id"`
	Status             ClarificationStatus `json:"status"`
	InitialPrompt      string              `json:"initial_prompt"`
	Round              int                 `json:"round"`
	MaxRounds          int                 `json:"max_rounds"`
	RequirementJSON    string              `json:"requirement_json"`
	OpenHighImpactJSON string              `json:"open_high_impact_json,omitempty"`
	CreatedJobID       string              `json:"created_job_id,omitempty"`
	ErrorCode          string              `json:"error_code,omitempty"`
	ErrorMessage       string              `json:"error_message,omitempty"`
	CreatedAt          time.Time           `json:"created_at"`
	UpdatedAt          time.Time           `json:"updated_at"`
	ConfirmedAt        *time.Time          `json:"confirmed_at,omitempty"`
	AbandonedAt        *time.Time          `json:"abandoned_at,omitempty"`
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
	ID          string     `json:"id"`
	DialogueID  string     `json:"dialogue_id"`
	MessageID   string     `json:"message_id"`
	Intent      TurnIntent `json:"intent"`
	Status      TurnStatus `json:"status"`
	SummaryJSON string     `json:"summary_json,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	StartedAt   *time.Time `json:"started_at,omitempty"`
	EndedAt     *time.Time `json:"ended_at,omitempty"`
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
	ID            string    `json:"id"`
	DialogueID    string    `json:"dialogue_id"`
	Sequence      int64     `json:"sequence"`
	TaskID        string    `json:"task_id,omitempty"`
	ApplicationID string    `json:"application_id,omitempty"`
	VersionID     string    `json:"version_id,omitempty"`
	StepID        string    `json:"step_id,omitempty"`
	Attempt       int       `json:"attempt,omitempty"`
	AgentKey      string    `json:"agent_key,omitempty"`
	Type          string    `json:"type"`
	PayloadJSON   string    `json:"payload_json"`
	CreatedAt     time.Time `json:"created_at"`
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
	WorkTraceIntent        WorkTraceType = "intent"              // recognized user intent surfaced
	WorkTraceApproach      WorkTraceType = "approach"            // chosen approach/plan surfaced
	WorkTraceAssumption    WorkTraceType = "assumption"          // stated assumption surfaced
	WorkTraceClarification WorkTraceType = "clarification"       // clarification question/answer
	WorkTraceTool          WorkTraceType = "tool"                // tool action summary (not raw I/O)
	WorkTraceData          WorkTraceType = "data"                // data gathered/produced summary
	WorkTraceValidation    WorkTraceType = "validation"          // validation/check result
	WorkTraceChangeConfirm WorkTraceType = "change_confirmation" // proposed change awaiting user confirm
	WorkTraceTask          WorkTraceType = "task"                // task status transition
	WorkTraceVersion       WorkTraceType = "version"             // application version transition
	WorkTraceDeployment    WorkTraceType = "deployment"          // deployment transition
	WorkTraceWarning       WorkTraceType = "warning"             // non-fatal warning surfaced
	WorkTraceError         WorkTraceType = "error"               // error surfaced
	WorkTraceAssistant     WorkTraceType = "assistant_output"    // assistant text output
)

// ProjectDocumentDraftStatus is the lifecycle state of a saved Markdown document
// draft. Drafts are stored separately from generated project documents and never
// overwrite machine contracts or the running application until a later confirmed
// generation task consumes the proposed change.
type ProjectDocumentDraftStatus string

const (
	ProjectDocumentDraftStatusDraft     ProjectDocumentDraftStatus = "draft"
	ProjectDocumentDraftStatusProposed  ProjectDocumentDraftStatus = "proposed"
	ProjectDocumentDraftStatusDiscarded ProjectDocumentDraftStatus = "discarded"
)

type ProjectDocumentDraft struct {
	ID              string                     `json:"id"`
	ApplicationID   string                     `json:"application_id"`
	DialogueID      string                     `json:"dialogue_id"`
	Path            string                     `json:"path"`
	SourceChecksum  string                     `json:"source_checksum"`
	Content         string                     `json:"content,omitempty"`
	Status          ProjectDocumentDraftStatus `json:"status"`
	ConversionError string                     `json:"conversion_error,omitempty"`
	CreatedAt       time.Time                  `json:"created_at"`
	UpdatedAt       time.Time                  `json:"updated_at"`
	ProposedTurnID  string                     `json:"proposed_turn_id,omitempty"`
	ProposedAt      *time.Time                 `json:"proposed_at,omitempty"`
}

// TaskThinkingEvent is one durable, immutable row of raw provider thinking
// captured during task execution. Unlike WorkTraceEvent and StepExecutionRecord,
// this row is excluded from visible work trace, execution audit/export surfaces,
// and ordinary dialogue messages. It is surfaced only in the conversation UI's
// task_execution_block (任务思考过程) after credential redaction/capping.
// DialogueSequence is per dialogue_id and assigned by the store (MAX+1 in one
// transaction). StepSequence is per (task_id, step_id, attempt) and also assigned
// by the store.
type TaskThinkingEvent struct {
	ID               string    `json:"id"`
	DialogueID       string    `json:"dialogue_id"`
	TaskID           string    `json:"task_id,omitempty"`
	StepID           string    `json:"step_id,omitempty"`
	Attempt          int       `json:"attempt,omitempty"`
	AgentKey         string    `json:"agent_key,omitempty"`
	DialogueSequence int64     `json:"dialogue_sequence"`
	StepSequence     int       `json:"step_sequence"`
	Content          string    `json:"content"`
	Redacted         bool      `json:"redacted"`
	CreatedAt        time.Time `json:"created_at"`
}

// AttachmentStatus is the lifecycle state of a dialogue attachment. Active
// attachments are usable by agents; deactivated ones remain for audit history.
type AttachmentStatus string

const (
	AttachmentStatusActive      AttachmentStatus = "active"
	AttachmentStatusDeactivated AttachmentStatus = "deactivated"
)

// AttachmentPreviewKind selects how the UI renders a stored attachment. The
// value is persisted verbatim into dialogue_attachments.preview_kind.
type AttachmentPreviewKind string

const (
	AttachmentPreviewImage    AttachmentPreviewKind = "image"
	AttachmentPreviewMarkdown AttachmentPreviewKind = "markdown"
	AttachmentPreviewText     AttachmentPreviewKind = "text"
	AttachmentPreviewJSON     AttachmentPreviewKind = "json"
	AttachmentPreviewCSV      AttachmentPreviewKind = "csv"
	AttachmentPreviewPDF      AttachmentPreviewKind = "pdf"
	AttachmentPreviewMetadata AttachmentPreviewKind = "metadata"
	AttachmentPreviewBlocked  AttachmentPreviewKind = "blocked"
)

// DialogueAttachment is a file uploaded into a dialogue session. Stored on
// disk under ArtifactRoot/dialogue-attachments/<dialogueID>/<id>/<name>; its
// metadata is persisted in dialogue_attachments. Credential-like files must
// never reach this table (rejected at the upload boundary).
type DialogueAttachment struct {
	ID            string                `json:"id"`
	DialogueID    string                `json:"dialogue_id"`
	FocusKey      string                `json:"focus_key"`
	OriginalName  string                `json:"original_name"`
	StoredPath    string                `json:"stored_path,omitempty"`
	Mime          string                `json:"mime"`
	Extension     string                `json:"extension"`
	SizeBytes     int64                 `json:"size_bytes"`
	SHA256        string                `json:"sha256"`
	PreviewKind   AttachmentPreviewKind `json:"preview_kind"`
	Status        AttachmentStatus      `json:"status"`
	CreatedAt     time.Time             `json:"created_at"`
	DeactivatedAt *time.Time            `json:"deactivated_at,omitempty"`
}

// WorkbenchArtifactKind categorizes a WorkbenchArtifactRef by the artifact it
// points at. The string value is persisted verbatim into
// workbench_artifact_refs.kind. project_document is the early docs/*.md
// projection (Task 5); interface_preview is the design-contract-derived
// interface snapshot (Task 8); data_contract / sample_data are reserved for the
// later data-integration step.
type WorkbenchArtifactKind string

const (
	WorkbenchArtifactProjectDocument  WorkbenchArtifactKind = "project_document"
	WorkbenchArtifactInterfacePreview WorkbenchArtifactKind = "interface_preview"
	WorkbenchArtifactDataContract     WorkbenchArtifactKind = "data_contract"
	WorkbenchArtifactSampleData       WorkbenchArtifactKind = "sample_data"
)

// WorkbenchArtifactRef is one durable pointer to a task-owned workbench
// artifact (a projected project document, an interface-preview snapshot, a
// data contract). It is the aggregation layer's artifact surface: each ref is
// tagged with the aggregate card it belongs to (CardKey) so the orchestration
// view can render it on the right card, and carries a Kind so the frontend can
// route artifact-open by kind. Path is relative to the configured artifact
// root; PreviewURL is empty unless a serving endpoint is wired (deferred — the
// interface preview stores a manifest, not a servable HTML page). Status is the
// artifact lifecycle: provisional (snapshot retained, not yet promoted) or
// active. SnapshotHash is a content hash of the stored artifact for change
// detection.
type WorkbenchArtifactRef struct {
	ID           string                `json:"id"`
	DialogueID   string                `json:"dialogue_id"`
	JobID        string                `json:"job_id"`
	StepID       string                `json:"step_id"`
	CardKey      string                `json:"cardKey"`
	Kind         WorkbenchArtifactKind `json:"kind"`
	Label        string                `json:"label"`
	Path         string                `json:"path"`
	PreviewURL   string                `json:"previewUrl,omitempty"`
	SnapshotHash string                `json:"snapshotHash,omitempty"`
	Status       string                `json:"status"`
	CreatedAt    time.Time             `json:"created_at"`
	UpdatedAt    time.Time             `json:"updated_at"`
}

// DialogueAttachmentRef links a stored attachment to the dialogue message that
// uses it. A single attachment can be referenced by multiple messages; refs
// deactivate independently so removal from one message keeps the file alive
// for others.
type DialogueAttachmentRef struct {
	ID            string             `json:"id"`
	DialogueID    string             `json:"dialogue_id"`
	MessageID     string             `json:"message_id"`
	AttachmentID  string             `json:"attachment_id"`
	FocusKey      string             `json:"focus_key"`
	Active        bool               `json:"active"`
	CreatedAt     time.Time          `json:"created_at"`
	DeactivatedAt *time.Time         `json:"deactivated_at,omitempty"`
	Attachment    DialogueAttachment `json:"attachment"`
}
