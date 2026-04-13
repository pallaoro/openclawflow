// ---- clawflow v0.2 --------------------------------------------------------------
// Declarative agentic workflow format.
// Designed to be written by LLMs, run anywhere.
//
// Runtime targets:
//   - OpenClaw plugin (this package)
//   - Cloudflare Workers (via transpiler -- see transpile.ts)
//   - Standalone Node.js server (future)

// ---- Flow Definition ------------------------------------------------------------

export interface FlowDefinition {
  flow: string; // unique name, e.g. "triage-support-ticket"
  version?: string; // semver, e.g. "1.0.0"
  description?: string;
  trigger?: FlowTrigger;
  /** Environment variables the flow expects. Values are defaults; null means required (runtime must provide). */
  env?: Record<string, string | null>;
  nodes: FlowNode[];
}

export interface FlowTrigger {
  on: "webhook" | "cron" | "manual" | "event" | string;
  from?: string; // source label e.g. "helpdesk"
  schedule?: string; // cron expression if on: cron
}

// ---- Retry Policy ---------------------------------------------------------------
// Applies to any node. Learned from Cloudflare WorkflowStepConfig.

export interface RetryPolicy {
  limit: number; // max attempts (default: 1 = no retry)
  delay: string | number; // e.g. "2s", "1m", or milliseconds
  backoff?: "linear" | "exponential" | "constant";
}

// ---- Node Union -----------------------------------------------------------------

export type FlowNode =
  | AiNode
  | AgentNode
  | BranchNode
  | ConditionNode
  | LoopNode
  | ParallelNode
  | HttpNode
  | MemoryNode
  | WaitNode
  | SleepNode
  | CodeNode
  | ExecNode;

export interface BaseNode {
  name: string;
  do: string;
  output?: string; // store result under this key in flow state
  retry?: RetryPolicy; // per-node retry policy
  timeout?: string | number; // e.g. "30s", or ms integer
}

// Helper: compile-time check that a key tuple matches exactly the own keys of T (minus BaseNode).
// If a key is added to an interface but not the tuple (or vice versa), this produces a type error
// on the corresponding _XCheck variable below.
type OwnKeys<T extends BaseNode> = Exclude<keyof T, keyof BaseNode>;
type CheckKeys<T extends BaseNode, K extends readonly string[]> =
  [OwnKeys<T>] extends [K[number]]
    ? [K[number]] extends [OwnKeys<T>]
      ? true
      : "Extra key(s) in tuple not on interface"
    : "Missing key(s) from interface in tuple";

// ---- Node Types -----------------------------------------------------------------

export interface AiNode extends BaseNode {
  do: "ai";
  prompt: string;
  input?: string; // dotted path into flow state
  schema?: Record<string, string>; // output shape; enables JSON mode
  model?: "fast" | "smart" | "best" | string;
  temperature?: number;
  maxTokens?: number;
  /** File paths (images, PDFs) to include as multimodal content. Supports templates. */
  attachments?: string[];
}
const AI_KEYS = ["prompt", "input", "schema", "model", "temperature", "maxTokens", "attachments"] as const;
const _aiCheck: CheckKeys<AiNode, typeof AI_KEYS> = true;

export interface AgentNode extends BaseNode {
  do: "agent";
  task: string;
  input?: string;
  tools?: string[];
  /** OpenClaw agent ID to delegate to (e.g. "main", "clawflow"). Uses OpenClaw's default routing if omitted. */
  agentId?: string;
}
const AGENT_KEYS = ["task", "input", "tools", "agentId"] as const;
const _agentCheck: CheckKeys<AgentNode, typeof AGENT_KEYS> = true;

export interface BranchNode extends BaseNode {
  do: "branch";
  on: string; // dotted path in flow state
  paths: Record<string, FlowNode[]>; // value -> sub-flow to execute
  default?: FlowNode[]; // sub-flow if no path matches
}
const BRANCH_KEYS = ["on", "paths", "default"] as const;
const _branchCheck: CheckKeys<BranchNode, typeof BRANCH_KEYS> = true;

export interface LoopNode extends BaseNode {
  do: "loop";
  over: string; // dotted path to array
  as: string; // variable name for current item
  nodes: FlowNode[];
}
const LOOP_KEYS = ["over", "as", "nodes"] as const;
const _loopCheck: CheckKeys<LoopNode, typeof LOOP_KEYS> = true;

export interface ParallelNode extends BaseNode {
  do: "parallel";
  nodes: FlowNode[];
  mode?: "all" | "race"; // "all" = wait for all, "race" = first wins
}
const PARALLEL_KEYS = ["nodes", "mode"] as const;
const _parallelCheck: CheckKeys<ParallelNode, typeof PARALLEL_KEYS> = true;

export interface HttpNode extends BaseNode {
  do: "http";
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: string | Record<string, unknown>;
  headers?: Record<string, string>;
}
const HTTP_KEYS = ["url", "method", "body", "headers"] as const;
const _httpCheck: CheckKeys<HttpNode, typeof HTTP_KEYS> = true;

export interface MemoryNode extends BaseNode {
  do: "memory";
  action: "read" | "write" | "delete";
  key: string;
  value?: string; // required for write
}
const MEMORY_KEYS = ["action", "key", "value"] as const;
const _memoryCheck: CheckKeys<MemoryNode, typeof MEMORY_KEYS> = true;

/**
 * wait — pause for human approval or external event.
 *
 * for: "approval" — human-in-the-loop gate with token-based resume.
 *   Registers a pending approval, provides a token for resume.
 *   On approval: output = { approved: true, approvedAt: string, token: string }
 *   On denial: flow is cancelled.
 *
 * for: "event" — wait for an external event (webhook, signal).
 *
 * Example:
 *   - name: review-pdfs
 *     do: wait
 *     for: approval
 *     prompt: "Review generated PDFs for {{ parsed.client_name }}"
 *     preview: "process_sheets[*].pdfPath"
 *     timeout: "24h"
 *     output: approval
 */
export interface WaitNode extends BaseNode {
  do: "wait";
  for: "approval" | "event";
  prompt?: string; // shown for approval gates (supports templates)
  preview?: string; // dotted path or wildcard to data shown alongside prompt (for: approval)
  event?: string; // event type to match (for: event)
  timeout?: string; // e.g. "24h", "5m" -- fail if exceeded
}
const WAIT_KEYS = ["for", "prompt", "preview", "event"] as const;
const _waitCheck: CheckKeys<WaitNode, typeof WAIT_KEYS> = true;

export interface SleepNode extends BaseNode {
  do: "sleep";
  duration: string; // e.g. "30s", "5m", "2h", "1d"
}
const SLEEP_KEYS = ["duration"] as const;
const _sleepCheck: CheckKeys<SleepNode, typeof SLEEP_KEYS> = true;

export interface CodeNode extends BaseNode {
  do: "code";
  run: string;
  input?: string;
}
const CODE_KEYS = ["run", "input"] as const;
const _codeCheck: CheckKeys<CodeNode, typeof CODE_KEYS> = true;

/**
 * exec — run a shell command deterministically, no AI involved.
 * Templates in `command` are resolved before execution.
 * Output: { stdout: string, stderr: string, exitCode: number }
 *
 * Example:
 *   - name: build-pdf
 *     do: exec
 *     command: "python3 /path/fill_foglio.py '{{ pdfPath }}' '{{ sheet | json }}'"
 *     output: buildResult
 */
export interface ExecNode extends BaseNode {
  do: "exec";
  command: string;
  cwd?: string; // working directory (resolved via templates)
}
const EXEC_KEYS = ["command", "cwd"] as const;
const _execCheck: CheckKeys<ExecNode, typeof EXEC_KEYS> = true;

/**
 * condition — if/else with sub-node blocks that reconverge.
 * Like branch, condition runs inline sub-nodes and merges back into
 * the main flow. Use condition for boolean logic, branch for multi-way
 * value matching.
 *
 * The `if` field is a JS expression evaluated against flow state.
 * Dotted paths like "order.status" resolve from state.
 * Comparison operators: ==, !=, >, <, >=, <=
 * Logical operators: &&, ||, !
 *
 * Example:
 *   - name: check-transport
 *     do: condition
 *     if: "extractOrder.transport_type == 'CLIENTE'"
 *     then:
 *       - name: pickup-note
 *         do: code
 *         run: "'Client picks up'"
 *         output: note
 *     else:
 *       - name: delivery-note
 *         do: code
 *         run: "'We deliver'"
 *         output: note
 *     output: condition_result
 */
export interface ConditionNode extends BaseNode {
  do: "condition";
  if: string; // JS expression evaluated against flow state
  then: FlowNode[]; // nodes to run when condition is true
  else?: FlowNode[]; // nodes to run when condition is false
}
const CONDITION_KEYS = ["if", "then", "else"] as const;
const _conditionCheck: CheckKeys<ConditionNode, typeof CONDITION_KEYS> = true;

// ---- Allowed Node Keys (derived from interfaces above) --------------------------
// Used by the validator to reject unknown fields. The ExactKeys constraint ensures
// a compile error if a key list drifts from its interface.

const BASE_KEYS: readonly string[] = ["name", "do", "output", "retry", "timeout"];

export const NODE_KEYS: Record<string, ReadonlySet<string>> = {
  ai:        new Set([...BASE_KEYS, ...AI_KEYS]),
  agent:     new Set([...BASE_KEYS, ...AGENT_KEYS]),
  branch:    new Set([...BASE_KEYS, ...BRANCH_KEYS]),
  condition: new Set([...BASE_KEYS, ...CONDITION_KEYS]),
  loop:      new Set([...BASE_KEYS, ...LOOP_KEYS]),
  parallel:  new Set([...BASE_KEYS, ...PARALLEL_KEYS]),
  http:      new Set([...BASE_KEYS, ...HTTP_KEYS]),
  memory:    new Set([...BASE_KEYS, ...MEMORY_KEYS]),
  wait:      new Set([...BASE_KEYS, ...WAIT_KEYS]),
  sleep:     new Set([...BASE_KEYS, ...SLEEP_KEYS]),
  code:      new Set([...BASE_KEYS, ...CODE_KEYS]),
  exec:      new Set([...BASE_KEYS, ...EXEC_KEYS]),
};

// ---- Runtime Types --------------------------------------------------------------

export interface FlowState {
  trigger?: unknown;
  [key: string]: unknown;
}

// Vocabulary aligned with Cloudflare InstanceStatus for future portability
export type NodeStatus =
  | "queued"
  | "running"
  | "ok"
  | "retrying"
  | "error"
  | "skipped"
  | "waiting"
  | "paused";

export interface TraceEntry {
  node: string;
  do: string;
  status: NodeStatus;
  attempt?: number; // which retry attempt (1-based)
  output?: unknown;
  error?: string;
  durationMs: number;
}

export type FlowStatus =
  | "running"
  | "completed"
  | "paused"
  | "waiting"
  | "failed"
  | "cancelled";

export interface FlowResult {
  ok: boolean;
  status: FlowStatus;
  flowName: string;
  instanceId: string; // stable ID for this run
  state: FlowState;
  trace: TraceEntry[];
  // Set when status = "paused" (approval/approve) or "waiting" (event)
  pausedAt?: string;
  resumeToken?: string;
  waitingFor?: {
    type: "approval" | "event";
    event?: string; // event type name if waiting for event
    prompt?: string;
    preview?: unknown; // resolved preview data for approve nodes
    timeout?: string;
  };
  error?: string;
}

// ---- Pending Approval -----------------------------------------------------------

export interface PendingApproval {
  token: string; // short random token for resume
  instanceId: string;
  flowName: string;
  node: string; // approve node name
  prompt: string; // resolved prompt text
  preview?: unknown; // resolved preview data
  createdAt: string;
  expiresAt: string;
}

// ---- Inference Function ---------------------------------------------------------
// Pluggable AI completion function. When running inside OpenClaw, the plugin
// injects a function that calls the gateway's OpenAI-compatible endpoint,
// reusing whatever providers/keys are already configured.

/** A single content part in a multimodal message (OpenAI/OpenRouter-compatible format). */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

export interface InferenceRequest {
  model: string;
  system: string;
  prompt: string;
  /** When set, the prompt is multimodal — providers should use this instead of `prompt`. */
  content?: ContentPart[];
  temperature?: number;
  maxTokens?: number;
}

export interface InferenceResult {
  text: string;
}

export type InferenceFn = (req: InferenceRequest) => Promise<InferenceResult>;

// ---- Plugin Config --------------------------------------------------------------

export interface ServeConfig {
  port: number;
  path?: string; // base path prefix, default "/flows"
  flowsDir?: string; // directory containing .json flow files, default workspace/flows
}

export interface PluginConfig {
  apiKey?: string;
  defaultModel?: string;
  baseUrl?: string;
  memoryDir?: string;
  maxNodeDurationMs?: number;
  stateDir?: string; // where to persist flow state across restarts
  /** Override for AI inference — used by tests and embedders */
  inferenceFn?: InferenceFn;
  /** OpenClaw agent ID for do:agent nodes (e.g. "ops"). Falls back to --local if unset. */
  defaultAgent?: string;
  /** Webhook server config — starts an HTTP server for triggering flows externally */
  serve?: ServeConfig;
}

// ---- Model Shorthands -----------------------------------------------------------

export const MODEL_MAP: Record<string, string> = {
  fast: "google/gemini-3-flash-preview",
  smart: "anthropic/claude-sonnet-4.6",
  best: "minimax/minimax-m2.5",
};
export const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";

// OpenRouter uses provider-prefixed IDs with dots.
// Maps both shorthand aliases and resolved model IDs.
export const OPENROUTER_MODEL_MAP: Record<string, string> = {
  fast: "google/gemini-3-flash-preview",
  smart: "anthropic/claude-sonnet-4.6",
  best: "minimax/minimax-m2.5",
  "google/gemini-3-flash-preview": "google/gemini-3-flash-preview",
  "anthropic/claude-sonnet-4.6": "anthropic/claude-sonnet-4.6",
  "minimax/minimax-m2.5": "minimax/minimax-m2.5",
};

// ---- Duration Parser ------------------------------------------------------------
// Parses "30s", "5m", "2h", "1d" -> milliseconds

export function parseDuration(d: string | number): number {
  if (typeof d === "number") return d;
  const units: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  const match = d.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/);
  if (!match)
    throw new Error(
      `Invalid duration: "${d}". Use e.g. "30s", "5m", "2h", "1d"`,
    );
  return parseFloat(match[1]) * (units[match[2]] ?? 1000);
}
