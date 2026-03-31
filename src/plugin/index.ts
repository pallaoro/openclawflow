import { FlowRunner, sendEvent } from "../core/runner.js";
import { transpileToCloudflare } from "../core/transpile.js";
import { startWebhookServer } from "../core/serve.js";
import { validateFlow } from "../core/validate.js";
import type { FlowDefinition, FlowNode, PluginConfig } from "../core/types.js";

// ---- OpenClaw Plugin: clawflow ---------------------------------------------------
// Registers six tools:
//
//   flow_run           — execute a flow (inline or from file)
//   flow_resume        — resume after approval gate
//   flow_send_event    — push an event into a waiting flow
//   flow_status        — inspect a running/completed flow instance
//   flow_transpile     — convert a .flow definition to Cloudflare Workers TS
//   flow_edit          — edit nodes in a flow definition (file or inline)

interface PluginApi {
  registerTool: (def: object, opts?: { optional?: boolean }) => void;
  config?: {
    plugins?: { entries?: Record<string, { config?: PluginConfig }> };
    gateway?: { port?: number; host?: string };
    [key: string]: unknown;
  };
  runtime?: {
    config?: { loadConfig?: () => unknown };
    [key: string]: unknown;
  };
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

function register(api: PluginApi) {
  const rawCfg: PluginConfig =
    api.config?.plugins?.entries?.["clawflow"]?.config ?? {};

  // Auto-detect gateway URL when running inside OpenClaw
  const gatewayPort =
    rawCfg.gatewayUrl
      ? undefined // user explicitly configured, skip detection
      : api.config?.gateway?.port ??
        (process.env.OPENCLAW_GATEWAY_PORT
          ? parseInt(process.env.OPENCLAW_GATEWAY_PORT, 10)
          : 18789);

  const gatewayHost =
    api.config?.gateway?.host ?? process.env.OPENCLAW_GATEWAY_HOST ?? "127.0.0.1";

  const pluginCfg: PluginConfig = {
    ...rawCfg,
    // Auto-set gateway URL so do:ai nodes route through OpenClaw's providers
    gatewayUrl: rawCfg.gatewayUrl ?? `http://${gatewayHost}:${gatewayPort}`,
    gatewayToken:
      rawCfg.gatewayToken ??
      process.env.OPENCLAW_GATEWAY_TOKEN ??
      process.env.OPENCLAW_GATEWAY_PASSWORD,
  };

  api.logger?.info?.(
    `[clawflow] AI backend: gateway at ${pluginCfg.gatewayUrl}`,
  );

  const runner = new FlowRunner(pluginCfg);
  const store = runner.getStore();

  // ---- Webhook server (optional) ------------------------------------------------
  // Skip when spawned as a child agent (CLAWFLOW_NO_SERVE) to avoid port conflicts.
  if (pluginCfg.serve && !process.env.CLAWFLOW_NO_SERVE) {
    startWebhookServer({
      runner,
      serve: pluginCfg.serve,
      logger: api.logger,
    });
  }

  // ---- flow_run -----------------------------------------------------------------

  api.registerTool(
    {
      name: "flow_run",
      description: `Run an agentic workflow in the clawflow format.

Node types:
  ai       — LLM call, structured or freeform. Use schema: for typed output.
  agent    — open-ended autonomous task (falls back to high-capability AI)
  branch   — route to different nodes based on a value: { on, paths, default }
  loop     — iterate over a list: { over, as, nodes[] }
  parallel — run nodes concurrently: { nodes[], mode: "all"|"race" }
  http     — call an external API: { url, method, body, headers }
  memory   — persist data: { action: read|write|delete, key, value }
  wait     — pause for approval or event: { for: "approval"|"event", event?, timeout? }
  sleep    — pause for duration: { duration: "5m" }
  code     — inline JS expression: { run: "...", input? }

All nodes support retry: { limit, delay, backoff } and timeout.
Templates: use {{ nodeName.field }} to reference any value in flow state.
Returns instanceId for status tracking and resume.`,

      parameters: {
        type: "object",
        properties: {
          flow: {
            type: "object",
            properties: {
              flow: { type: "string" },
              description: { type: "string" },
              nodes: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
            },
            required: ["flow", "nodes"],
            additionalProperties: true,
          },
          file: {
            type: "string",
            description: "Path to a .json flow file",
          },
          input: {
            type: "object",
            additionalProperties: true,
            description: "Input data, available as trigger.* in the flow",
          },
        },
      },

      async execute(
        _id: string,
        params: { flow?: FlowDefinition; file?: string; input?: unknown },
      ) {
        let flowDef: FlowDefinition;

        if (params.file) {
          const { readFileSync, existsSync } = await import("fs");
          const base =
            process.env.OPENCLAW_WORKSPACE ?? process.cwd();
          const abs = params.file.startsWith("/")
            ? params.file
            : `${base}/${params.file}`;
          if (!existsSync(abs))
            return {
              content: [{ type: "text", text: `File not found: ${abs}` }],
            };
          flowDef = JSON.parse(
            readFileSync(abs, "utf8"),
          ) as FlowDefinition;
        } else if (params.flow) {
          flowDef = params.flow as FlowDefinition;
        } else {
          return {
            content: [
              {
                type: "text",
                text: "Provide either `flow` (inline definition) or `file` (path).",
              },
            ],
          };
        }

        try {
          const result = await runner.run(flowDef, params.input ?? {});
          return {
            content: [
              { type: "text", text: JSON.stringify(result, null, 2) },
            ],
            details: result,
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          };
        }
      },
    },
    { optional: true },
  );

  // ---- flow_resume --------------------------------------------------------------

  api.registerTool(
    {
      name: "flow_resume",
      description: `Resume a paused clawflow after an approval gate.
Use the instanceId (= resumeToken) from a flow_run result where status was "paused".
Set approved=true to continue, false to cancel.
You must pass the original flow definition back so the runner can continue.`,

      parameters: {
        type: "object",
        required: ["instanceId", "approved", "flow"],
        properties: {
          instanceId: {
            type: "string",
            description: "The instanceId from the paused flow_run result",
          },
          approved: { type: "boolean" },
          flow: {
            type: "object",
            required: ["flow", "nodes"],
            properties: {
              flow: { type: "string" },
              nodes: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
            },
            additionalProperties: true,
          },
        },
      },

      async execute(
        _id: string,
        params: {
          instanceId: string;
          approved: boolean;
          flow: FlowDefinition;
        },
      ) {
        try {
          const result = await runner.resume(
            params.instanceId,
            params.flow,
            params.approved,
          );
          return {
            content: [
              { type: "text", text: JSON.stringify(result, null, 2) },
            ],
            details: result,
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          };
        }
      },
    },
    { optional: true },
  );

  // ---- flow_send_event ----------------------------------------------------------

  api.registerTool(
    {
      name: "flow_send_event",
      description: `Send an event to a flow instance that is waiting with do: wait / for: event.
This is the equivalent of Cloudflare's instance.sendEvent().
The eventType must match the "event" field on the wait node.
payload is passed as the output of the wait node and into flow state.`,

      parameters: {
        type: "object",
        required: ["instanceId", "eventType"],
        properties: {
          instanceId: { type: "string" },
          eventType: {
            type: "string",
            description: "Must match the 'event' field of the wait node",
          },
          payload: {
            type: "object",
            additionalProperties: true,
          },
        },
      },

      async execute(
        _id: string,
        params: {
          instanceId: string;
          eventType: string;
          payload?: unknown;
        },
      ) {
        const delivered = sendEvent(
          params.instanceId,
          params.eventType,
          params.payload ?? {},
        );
        if (!delivered) {
          return {
            content: [
              {
                type: "text",
                text: `No active waiter found for instance "${params.instanceId}" event "${params.eventType}". The flow may not be waiting, or the event type doesn't match.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Event "${params.eventType}" delivered to instance "${params.instanceId}".`,
            },
          ],
        };
      },
    },
    { optional: true },
  );

  // ---- flow_status --------------------------------------------------------------

  api.registerTool(
    {
      name: "flow_status",
      description: `Get the status and state of a flow instance, or list all instances.
Status values: running | completed | paused | waiting | failed | cancelled`,

      parameters: {
        type: "object",
        properties: {
          instanceId: {
            type: "string",
            description: "Specific instance to inspect. Omit to list all.",
          },
          filter: {
            type: "string",
            description:
              "Filter by status: running | completed | paused | waiting | failed | cancelled",
          },
        },
      },

      async execute(
        _id: string,
        params: { instanceId?: string; filter?: string },
      ) {
        if (params.instanceId) {
          const record = store.get(params.instanceId);
          if (!record)
            return {
              content: [
                {
                  type: "text",
                  text: `Instance not found: ${params.instanceId}`,
                },
              ],
            };
          return {
            content: [
              { type: "text", text: JSON.stringify(record, null, 2) },
            ],
            details: record,
          };
        }
        const records = store.list(params.filter);
        const summary = records.map((r) => ({
          instanceId: r.instanceId,
          flow: r.flowName,
          status: r.status,
          updatedAt: r.updatedAt,
          waitingFor: r.waitingFor,
        }));
        return {
          content: [
            { type: "text", text: JSON.stringify(summary, null, 2) },
          ],
          details: summary,
        };
      },
    },
    { optional: true },
  );

  // ---- flow_transpile -----------------------------------------------------------

  api.registerTool(
    {
      name: "flow_transpile",
      description: `Convert a clawflow definition into a Cloudflare Workers TypeScript class.
Output is a complete .ts file you can deploy with: wrangler deploy
Each node maps to a Cloudflare Workflows primitive:
  ai/agent   → step.do()
  wait/event → step.waitForEvent()
  sleep      → step.sleep()
  parallel   → Promise.all() / Promise.race()`,

      parameters: {
        type: "object",
        required: ["flow"],
        properties: {
          flow: {
            type: "object",
            required: ["flow", "nodes"],
            properties: {
              flow: { type: "string" },
              nodes: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
            },
            additionalProperties: true,
          },
        },
      },

      async execute(
        _id: string,
        params: { flow: FlowDefinition },
      ) {
        try {
          const ts = transpileToCloudflare(params.flow);
          return { content: [{ type: "text", text: ts }] };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Transpile error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          };
        }
      },
    },
    { optional: true },
  );

  // ---- flow_edit ----------------------------------------------------------------

  api.registerTool(
    {
      name: "flow_edit",
      description: `Edit nodes in a clawflow definition. Operates on a file or inline flow.

Actions:
  update  — update a node entirely or patch specific fields by node name
  add     — insert a new node at a position (default: end)
  remove  — remove a node by name
  move    — move a node to a new position
  list    — list all nodes with index, name, type, and output key

The edited flow is validated after every mutation. If validation fails, the
edit is rejected and errors are returned. For file-based flows, the file is
overwritten with the updated definition on success.

Examples:
  Update one field:   { action: "update", node: "classify", fields: { prompt: "New prompt" } }
  Replace full node:  { action: "update", node: "classify", replace: { name: "classify", do: "ai", prompt: "..." } }
  Add at position:    { action: "add", position: 2, nodeDefinition: { name: "step3", do: "code", run: "..." } }
  Remove:             { action: "remove", node: "old-step" }
  Move:               { action: "move", node: "step3", position: 0 }
  List:               { action: "list" }`,

      parameters: {
        type: "object",
        required: ["action"],
        properties: {
          file: {
            type: "string",
            description: "Path to a .json flow file. Mutually exclusive with 'flow'.",
          },
          flow: {
            type: "object",
            description: "Inline flow definition. Mutually exclusive with 'file'.",
            properties: {
              flow: { type: "string" },
              nodes: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
            },
            required: ["flow", "nodes"],
            additionalProperties: true,
          },
          action: {
            type: "string",
            enum: ["update", "add", "remove", "move", "list"],
          },
          node: {
            type: "string",
            description: "Node name to target (required for update, remove, move)",
          },
          fields: {
            type: "object",
            additionalProperties: true,
            description: "For action=update: partial field updates to merge into the node",
          },
          replace: {
            type: "object",
            additionalProperties: true,
            description: "For action=update: full node replacement (must include name and do)",
          },
          nodeDefinition: {
            type: "object",
            additionalProperties: true,
            description: "For action=add: the new node definition",
          },
          position: {
            type: "number",
            description: "For action=add/move: index to insert/move to (0-based). Default: end.",
          },
        },
      },

      async execute(
        _id: string,
        params: {
          file?: string;
          flow?: FlowDefinition;
          action: "update" | "add" | "remove" | "move" | "list";
          node?: string;
          fields?: Record<string, unknown>;
          replace?: FlowNode;
          nodeDefinition?: FlowNode;
          position?: number;
        },
      ) {
        // ---- Load flow definition ---
        let flowDef: FlowDefinition;
        let filePath: string | undefined;

        if (params.file) {
          const { readFileSync, existsSync } = await import("fs");
          const base = process.env.OPENCLAW_WORKSPACE ?? process.cwd();
          const abs = params.file.startsWith("/")
            ? params.file
            : `${base}/${params.file}`;
          if (!existsSync(abs))
            return {
              content: [{ type: "text", text: `File not found: ${abs}` }],
            };
          filePath = abs;
          flowDef = JSON.parse(readFileSync(abs, "utf8")) as FlowDefinition;
        } else if (params.flow) {
          flowDef = params.flow;
        } else {
          return {
            content: [
              {
                type: "text",
                text: "Provide either `file` (path) or `flow` (inline definition).",
              },
            ],
          };
        }

        const ok = (msg: string, flow: FlowDefinition) => ({
          content: [{ type: "text", text: msg }],
          details: flow,
        });
        const fail = (msg: string) => ({
          content: [{ type: "text", text: msg }],
        });

        const findIndex = (name: string) =>
          flowDef.nodes.findIndex((n) => n.name === name);

        // ---- List ---
        if (params.action === "list") {
          const list = flowDef.nodes.map((n, i) => ({
            index: i,
            name: n.name,
            do: n.do,
            output: n.output ?? null,
          }));
          return {
            content: [
              { type: "text", text: JSON.stringify(list, null, 2) },
            ],
            details: list,
          };
        }

        // ---- Update ---
        if (params.action === "update") {
          if (!params.node)
            return fail('action "update" requires "node" (node name).');
          const idx = findIndex(params.node);
          if (idx === -1)
            return fail(`Node "${params.node}" not found.`);

          if (params.replace) {
            flowDef.nodes[idx] = params.replace as FlowNode;
          } else if (params.fields) {
            flowDef.nodes[idx] = {
              ...flowDef.nodes[idx],
              ...params.fields,
            } as FlowNode;
          } else {
            return fail(
              'action "update" requires either "fields" (partial) or "replace" (full node).',
            );
          }

          const validation = validateFlow(flowDef);
          if (!validation.ok)
            return fail(
              `Validation failed after update:\n${validation.errors.map((e) => `  - ${e.message}`).join("\n")}`,
            );

          if (filePath) {
            const { writeFileSync } = await import("fs");
            writeFileSync(filePath, JSON.stringify(flowDef, null, 2) + "\n");
          }
          return ok(
            `Node "${params.node}" updated.${filePath ? ` File written: ${filePath}` : ""}`,
            flowDef,
          );
        }

        // ---- Add ---
        if (params.action === "add") {
          if (!params.nodeDefinition)
            return fail('action "add" requires "nodeDefinition".');
          const pos = params.position ?? flowDef.nodes.length;
          if (pos < 0 || pos > flowDef.nodes.length)
            return fail(
              `Position ${pos} out of range (0-${flowDef.nodes.length}).`,
            );
          flowDef.nodes.splice(pos, 0, params.nodeDefinition as FlowNode);

          const validation = validateFlow(flowDef);
          if (!validation.ok) {
            flowDef.nodes.splice(pos, 1); // rollback
            return fail(
              `Validation failed after add:\n${validation.errors.map((e) => `  - ${e.message}`).join("\n")}`,
            );
          }

          if (filePath) {
            const { writeFileSync } = await import("fs");
            writeFileSync(filePath, JSON.stringify(flowDef, null, 2) + "\n");
          }
          return ok(
            `Node "${params.nodeDefinition.name}" added at position ${pos}.${filePath ? ` File written: ${filePath}` : ""}`,
            flowDef,
          );
        }

        // ---- Remove ---
        if (params.action === "remove") {
          if (!params.node)
            return fail('action "remove" requires "node" (node name).');
          const idx = findIndex(params.node);
          if (idx === -1)
            return fail(`Node "${params.node}" not found.`);

          const removed = flowDef.nodes.splice(idx, 1)[0];

          const validation = validateFlow(flowDef);
          if (!validation.ok) {
            flowDef.nodes.splice(idx, 0, removed); // rollback
            return fail(
              `Validation failed after remove (rolled back):\n${validation.errors.map((e) => `  - ${e.message}`).join("\n")}`,
            );
          }

          if (filePath) {
            const { writeFileSync } = await import("fs");
            writeFileSync(filePath, JSON.stringify(flowDef, null, 2) + "\n");
          }
          return ok(
            `Node "${params.node}" removed.${filePath ? ` File written: ${filePath}` : ""}`,
            flowDef,
          );
        }

        // ---- Move ---
        if (params.action === "move") {
          if (!params.node)
            return fail('action "move" requires "node" (node name).');
          if (params.position === undefined)
            return fail('action "move" requires "position".');
          const idx = findIndex(params.node);
          if (idx === -1)
            return fail(`Node "${params.node}" not found.`);

          const [moved] = flowDef.nodes.splice(idx, 1);
          const pos = Math.min(params.position, flowDef.nodes.length);
          flowDef.nodes.splice(pos, 0, moved);

          const validation = validateFlow(flowDef);
          if (!validation.ok) {
            // rollback: remove from new pos, re-insert at old
            flowDef.nodes.splice(pos, 1);
            flowDef.nodes.splice(idx, 0, moved);
            return fail(
              `Validation failed after move (rolled back):\n${validation.errors.map((e) => `  - ${e.message}`).join("\n")}`,
            );
          }

          if (filePath) {
            const { writeFileSync } = await import("fs");
            writeFileSync(filePath, JSON.stringify(flowDef, null, 2) + "\n");
          }
          return ok(
            `Node "${params.node}" moved to position ${pos}.${filePath ? ` File written: ${filePath}` : ""}`,
            flowDef,
          );
        }

        return fail(`Unknown action: "${params.action}"`);
      },
    },
    { optional: true },
  );
}

export default {
  id: "clawflow",
  register,
};
