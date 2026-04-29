#!/usr/bin/env node
/**
 * ClawFlow 0.x → 1.0 migration.
 *
 * Rewrites flow definitions in-place:
 *   - Removes the top-level `trigger` block (now a Clawnify-side concern)
 *   - Renames `{{ trigger.X }}` → `{{ inputs.X }}` in every string field
 *   - Renames bare path values `"trigger.X"` → `"inputs.X"` in node.input,
 *     loop.over, branch.on, condition.if (which take dotted state paths)
 *
 * Does not auto-generate an `inputs:` declaration block. Declared inputs are
 * left as a deliberate, human-curated upgrade — extras pass through at
 * runtime, and missing-required checks only kick in when you opt in.
 *
 * Usage:
 *   npx tsx scripts/migrate-to-1.0.ts <dir-or-file> [--dry]
 *   tsx scripts/migrate-to-1.0.ts ~/.openclaw/workspace/flows
 *   tsx scripts/migrate-to-1.0.ts path/to/flow.json --dry
 */

import * as fs from "fs";
import * as path from "path";

interface MigrateResult {
  file: string;
  changed: boolean;
  removedTrigger: boolean;
  templateRewrites: number;
  pathRewrites: number;
}

function rewriteString(s: string, counters: { templates: number; paths: number }): string {
  let out = s;

  // {{ trigger.X.Y | filter }}  →  {{ inputs.X.Y | filter }}
  // Only rewrite when "trigger" is the top-level identifier inside the {{ }}.
  out = out.replace(
    /\{\{\s*trigger(\.[\w.]+)?(\s*\|\s*\w+)?\s*\}\}/g,
    (_match: string, tail: string | undefined, filter: string | undefined) => {
      counters.templates += 1;
      return `{{ inputs${tail ?? ""}${filter ?? ""} }}`;
    },
  );

  // {{ trigger[*].field }}  →  {{ inputs[*].field }}
  out = out.replace(
    /\{\{\s*trigger(\[\*\](?:\.[\w.]+)?)\s*\}\}/g,
    (_match: string, tail: string) => {
      counters.templates += 1;
      return `{{ inputs${tail} }}`;
    },
  );

  return out;
}

/**
 * Bare dotted-path fields that the runtime resolves against state. These take
 * raw paths like "trigger.x" (no template braces). Found on: AiNode.input,
 * AgentNode.input, CodeNode.input, LoopNode.over, BranchNode.on,
 * ConditionNode.if (within JS expressions). We rewrite the leading `trigger.`
 * → `inputs.` and bare `trigger` → `inputs`.
 */
function rewriteBarePath(s: string, counters: { templates: number; paths: number }): string {
  // Quick reject: if the string contains `{{`, treat as template-only — those
  // are handled by rewriteString. Bare-path fields are pure dotted paths.
  if (s.includes("{{")) return s;
  if (s === "trigger") {
    counters.paths += 1;
    return "inputs";
  }
  if (s.startsWith("trigger.")) {
    counters.paths += 1;
    return "inputs." + s.slice("trigger.".length);
  }
  return s;
}

/**
 * In ConditionNode.if, the body is a JS-ish expression that may reference
 * `trigger.X` as an identifier. Rewrite identifier-prefixed `trigger.` → `inputs.`.
 */
function rewriteExpression(s: string, counters: { templates: number; paths: number }): string {
  // Match `trigger` as a whole word followed by `.` or end. Avoids hitting
  // strings inside literals — but for safety we also skip quoted regions.
  const regions: { start: number; end: number }[] = [];
  const literalRe = /'[^']*'|"[^"]*"/g;
  let m: RegExpExecArray | null;
  while ((m = literalRe.exec(s)) !== null) {
    regions.push({ start: m.index, end: m.index + m[0].length });
  }
  const inLiteral = (i: number) =>
    regions.some((r) => i >= r.start && i < r.end);

  return s.replace(/\btrigger\b/g, (match: string, offset: number) => {
    if (inLiteral(offset)) return match;
    counters.paths += 1;
    return "inputs";
  });
}

const BARE_PATH_FIELDS = new Set(["input", "over", "on"]);
const EXPRESSION_FIELDS = new Set(["if"]);

function migrateValue(
  value: unknown,
  counters: { templates: number; paths: number },
  fieldName?: string,
): unknown {
  if (typeof value === "string") {
    if (fieldName && BARE_PATH_FIELDS.has(fieldName)) {
      return rewriteString(rewriteBarePath(value, counters), counters);
    }
    if (fieldName && EXPRESSION_FIELDS.has(fieldName)) {
      return rewriteString(rewriteExpression(value, counters), counters);
    }
    return rewriteString(value, counters);
  }
  if (Array.isArray(value)) {
    return value.map((v) => migrateValue(v, counters, fieldName));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = migrateValue(v, counters, k);
    }
    return out;
  }
  return value;
}

function migrateFlowDef(def: Record<string, unknown>): {
  next: Record<string, unknown>;
  removedTrigger: boolean;
  templateRewrites: number;
  pathRewrites: number;
} {
  const counters = { templates: 0, paths: 0 };
  const removedTrigger = "trigger" in def;

  // Drop top-level trigger field. Don't migrate it into `inputs:` — declarations
  // are an opt-in upgrade.
  const { trigger: _trigger, ...rest } = def;

  const migratedNodes = migrateValue(rest.nodes, counters);

  const next: Record<string, unknown> = { ...rest, nodes: migratedNodes };

  return {
    next,
    removedTrigger,
    templateRewrites: counters.templates,
    pathRewrites: counters.paths,
  };
}

function migrateFile(file: string, dry: boolean): MigrateResult {
  const raw = fs.readFileSync(file, "utf8");
  const def = JSON.parse(raw) as Record<string, unknown>;

  const { next, removedTrigger, templateRewrites, pathRewrites } = migrateFlowDef(def);
  const changed = removedTrigger || templateRewrites > 0 || pathRewrites > 0;

  if (changed && !dry) {
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  }

  return { file, changed, removedTrigger, templateRewrites, pathRewrites };
}

function walk(target: string): string[] {
  const stat = fs.statSync(target);
  if (stat.isFile()) return target.endsWith(".json") ? [target] : [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(target)) {
    const p = path.join(target, entry);
    const s = fs.statSync(p);
    if (s.isDirectory()) {
      // Skip versions directory — those are immutable snapshots; users should
      // re-publish from a migrated draft.
      if (entry === ".clawflow" || entry === "node_modules") continue;
      out.push(...walk(p));
    } else if (entry.endsWith(".json")) {
      out.push(p);
    }
  }
  return out;
}

function main(): void {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const targets = args.filter((a) => !a.startsWith("--"));

  if (targets.length === 0) {
    console.error("usage: migrate-to-1.0 <dir-or-file>... [--dry]");
    process.exit(2);
  }

  const files: string[] = [];
  for (const t of targets) {
    const abs = path.resolve(t);
    if (!fs.existsSync(abs)) {
      console.error(`not found: ${abs}`);
      process.exit(2);
    }
    files.push(...walk(abs));
  }

  const results: MigrateResult[] = [];
  for (const file of files) {
    try {
      results.push(migrateFile(file, dry));
    } catch (err) {
      console.error(`skip ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const changed = results.filter((r) => r.changed);
  const totalTemplates = changed.reduce((s, r) => s + r.templateRewrites, 0);
  const totalPaths = changed.reduce((s, r) => s + r.pathRewrites, 0);
  const triggersDropped = changed.filter((r) => r.removedTrigger).length;

  console.log(`${dry ? "DRY RUN — " : ""}migrated ${changed.length}/${results.length} flow files`);
  console.log(`  template rewrites: ${totalTemplates}`);
  console.log(`  path rewrites:     ${totalPaths}`);
  console.log(`  trigger blocks dropped: ${triggersDropped}`);

  if (changed.length > 0) {
    console.log("\nfiles changed:");
    for (const r of changed) {
      const parts: string[] = [];
      if (r.removedTrigger) parts.push("removed trigger");
      if (r.templateRewrites > 0) parts.push(`${r.templateRewrites} template${r.templateRewrites === 1 ? "" : "s"}`);
      if (r.pathRewrites > 0) parts.push(`${r.pathRewrites} path${r.pathRewrites === 1 ? "" : "s"}`);
      console.log(`  ${r.file} — ${parts.join(", ")}`);
    }
  }

  if (dry) {
    console.log("\n(dry run — no files written. re-run without --dry to apply.)");
  }
}

main();
