import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import {
  FlowRunner,
  StepRegistry,
  registerStepType,
  defaultRegistry,
  validateFlow,
} from "../src/index.js";
import type { FlowDefinition, PluginConfig } from "../src/index.js";

const tmpDir = path.join(os.tmpdir(), `ocf-custom-test-${Date.now()}`);
const baseCfg: PluginConfig = {
  stateDir: path.join(tmpDir, "state"),
  memoryDir: path.join(tmpDir, "memory"),
};

function cleanup() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function freshRunner(extra?: Partial<PluginConfig>): { runner: FlowRunner; registry: StepRegistry } {
  // Use a private registry per test so registrations don't leak across cases.
  const registry = new StepRegistry();
  const runner = new FlowRunner({ ...baseCfg, ...extra, customSteps: registry });
  return { runner, registry };
}

describe("Custom step types", () => {
  after(cleanup);

  it("runs a registered step end-to-end and stores its output", async () => {
    const { runner, registry } = freshRunner();
    registry.register({
      name: "echo",
      allowedKeys: ["message"],
      run: (input) => ({ said: (input as { message: string }).message }),
    });

    const flow: FlowDefinition = {
      flow: "test-custom-echo",
      nodes: [
        {
          name: "say",
          do: "echo" as unknown as "code",
          // @ts-expect-error custom field not in built-in types
          message: "hi",
          output: "result",
        } as unknown as FlowDefinition["nodes"][number],
      ],
    };

    const result = await runner.run(flow, {});
    assert.equal(result.ok, true);
    assert.deepEqual(result.state.result, { said: "hi" });
  });

  it("pre-resolves {{ template }} strings in input fields like http does", async () => {
    const { runner, registry } = freshRunner();
    let received: unknown;
    registry.register({
      name: "capture",
      allowedKeys: ["msg"],
      run: (input) => {
        received = input;
        return null;
      },
    });

    const flow: FlowDefinition = {
      flow: "test-custom-template",
      nodes: [
        {
          name: "cap",
          do: "capture" as unknown as "code",
          // @ts-expect-error
          msg: "hello {{ inputs.who }}",
          output: "out",
        } as unknown as FlowDefinition["nodes"][number],
      ],
    };

    const result = await runner.run(flow, { who: "world" });
    assert.equal(result.ok, true);
    assert.deepEqual(received, { msg: "hello world" });
  });

  it("provides ctx.state, ctx.env, ctx.nodeName, and ctx.abortSignal", async () => {
    const { runner, registry } = freshRunner();
    let captured: { hasState: boolean; env: unknown; nodeName: string; signal: boolean } | undefined;
    registry.register({
      name: "introspect",
      allowedKeys: [],
      run: (_input, ctx) => {
        captured = {
          hasState: typeof ctx.state === "object" && ctx.state !== null,
          env: ctx.env,
          nodeName: ctx.nodeName,
          signal: ctx.abortSignal instanceof AbortSignal,
        };
        return "ok";
      },
    });

    const flow: FlowDefinition = {
      flow: "test-custom-ctx",
      env: { GREETING: "hi" },
      nodes: [
        {
          name: "look",
          do: "introspect" as unknown as "code",
          output: "out",
        } as unknown as FlowDefinition["nodes"][number],
      ],
    };

    process.env.GREETING = "hi";
    const result = await runner.run(flow, {});
    delete process.env.GREETING;
    assert.equal(result.ok, true, result.error);
    assert.ok(captured);
    assert.equal(captured!.hasState, true);
    assert.equal(captured!.nodeName, "look");
    assert.equal(captured!.signal, true);
    assert.deepEqual(captured!.env, { GREETING: "hi" });
  });

  it("freezes ctx.state so steps can't mutate flow state", async () => {
    const { runner, registry } = freshRunner();
    let mutationError: Error | null = null;
    registry.register({
      name: "mutator",
      allowedKeys: [],
      run: (_input, ctx) => {
        try {
          (ctx.state as Record<string, unknown>).foo = "bar";
        } catch (err) {
          mutationError = err as Error;
        }
        return "tried";
      },
    });

    const flow: FlowDefinition = {
      flow: "test-custom-frozen",
      nodes: [
        {
          name: "mutate",
          do: "mutator" as unknown as "code",
          output: "out",
        } as unknown as FlowDefinition["nodes"][number],
      ],
    };

    const result = await runner.run(flow, {});
    assert.equal(result.ok, true);
    assert.ok(mutationError instanceof Error);
  });

  it("surfaces validator errors with native validation shape", async () => {
    const { registry } = freshRunner();
    registry.register({
      name: "strict",
      allowedKeys: ["x"],
      validate: (input) => {
        const i = input as { x?: unknown };
        if (typeof i.x !== "number") {
          return { ok: false, errors: [{ field: "x", message: "x must be a number" }] };
        }
        return { ok: true };
      },
      run: () => null,
    });

    const flow: FlowDefinition = {
      flow: "test-custom-validate",
      nodes: [
        {
          name: "v",
          do: "strict" as unknown as "code",
          // @ts-expect-error
          x: "not a number",
        } as unknown as FlowDefinition["nodes"][number],
      ],
    };

    const result = validateFlow(flow, { registry });
    assert.equal(result.ok, false);
    const xErr = result.errors.find((e) => e.field === "x");
    assert.ok(xErr, "expected error on field x");
    assert.equal(xErr!.node, "v");
    assert.match(xErr!.message, /x must be a number/);
  });

  it("rejects unknown fields based on allowedKeys", async () => {
    const { registry } = freshRunner();
    registry.register({
      name: "tight",
      allowedKeys: ["foo"],
      run: () => null,
    });

    const flow: FlowDefinition = {
      flow: "test-custom-unknown-field",
      nodes: [
        {
          name: "t",
          do: "tight" as unknown as "code",
          // @ts-expect-error
          foo: "ok",
          // @ts-expect-error
          bar: "nope",
        } as unknown as FlowDefinition["nodes"][number],
      ],
    };

    const result = validateFlow(flow, { registry });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.field === "bar"));
  });

  it("throws when a step name collides with a built-in", () => {
    const registry = new StepRegistry();
    assert.throws(
      () => registry.register({ name: "http", allowedKeys: [], run: () => null }),
      /collides with built-in/,
    );
  });

  it("throws on duplicate registration", () => {
    const registry = new StepRegistry();
    registry.register({ name: "once", allowedKeys: [], run: () => null });
    assert.throws(
      () => registry.register({ name: "once", allowedKeys: [], run: () => null }),
      /already registered/,
    );
  });

  it("fails fast with a clear message when the step is not registered", async () => {
    const { runner } = freshRunner();
    const flow: FlowDefinition = {
      flow: "test-custom-missing",
      nodes: [
        {
          name: "ghost",
          do: "not_registered" as unknown as "code",
        } as unknown as FlowDefinition["nodes"][number],
      ],
    };
    const result = await runner.run(flow, {});
    assert.equal(result.ok, false);
    // Static validator catches it first with "Unknown node type"
    assert.match(result.error ?? "", /Unknown node type|Unknown step type/);
  });

  it("propagates errors thrown inside run() into the trace", async () => {
    const { runner, registry } = freshRunner();
    registry.register({
      name: "boom",
      allowedKeys: [],
      run: () => {
        throw new Error("kaboom");
      },
    });

    const flow: FlowDefinition = {
      flow: "test-custom-throw",
      nodes: [
        {
          name: "go",
          do: "boom" as unknown as "code",
        } as unknown as FlowDefinition["nodes"][number],
      ],
    };

    const result = await runner.run(flow, {});
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /kaboom/);
    const trace = result.trace.find((t) => t.node === "go");
    assert.equal(trace?.status, "error");
  });

  it("module-level registerStepType writes to the default registry", () => {
    const before = defaultRegistry.has("module_level_demo");
    assert.equal(before, false);
    registerStepType({
      name: "module_level_demo",
      allowedKeys: [],
      run: () => "ok",
    });
    assert.equal(defaultRegistry.has("module_level_demo"), true);
    // Cleanup so this test can be re-run in watch mode
    defaultRegistry.clear();
  });
});
