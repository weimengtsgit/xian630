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
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type Agent struct {
	ID              string `json:"id"`
	Key             string `json:"key"`
	Name            string `json:"name"`
	Role            string `json:"role"`
	Description     string `json:"description"`
	ClaudeAgentName string `json:"claude_agent_name"`
	SkillsJSON      string `json:"skills_json"`
	Enabled         bool   `json:"enabled"`
	SortOrder       int    `json:"sort_order"`
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
