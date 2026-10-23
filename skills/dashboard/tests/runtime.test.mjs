// Run with node --test <skill>/tests/runtime.test.mjs.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import * as runtime from "../scripts/dashboard.mjs";
import * as library from "../scripts/library.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "dashboard.mjs");
let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-test-"));
  const initial = { title: "Demo", goal: "Verify", now: "Working", next: "Test", tasks: [], milestones: [], decisions: [], events: [], changedIds: [], updatedAt: runtime.now(), revision: 0 };
  runtime.atomic(path.join(root, "state.json"), initial);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test("merges tasks, validates patches and ignores no-op updates", () => {
  const first = runtime.update(root, { tasks: [{ id: "one", title: "First", status: "doing" }] });
  assert.equal(first.revision, 1);
  assert.equal(runtime.update(root, { tasks: [{ id: "one", status: "doing" }] }).revision, 1);
  const before = fs.readFileSync(path.join(root, "state.json"));
  for (const patch of [
    { tasks: [{ id: "one", status: "done" }] },
    { tasks: [{ id: "one", status: "blocked" }] },
    { milestones: [{ id: "m", title: "Milestone", taskIds: ["absent"] }] },
    { revision: 50 },
  ]) {
    assert.throws(() => runtime.update(root, patch));
    assert.deepEqual(fs.readFileSync(path.join(root, "state.json")), before);
  }
  const done = runtime.update(root, { tasks: [{ id: "one", status: "done", evidence: "User confirmed." }] });
  assert.equal(done.tasks[0].title, "First");
  assert.deepEqual(done.changedIds, ["one"]);
});

test("concurrent updates from separate processes preserve unrelated tasks", async () => {
  const run = promisify(execFile);
  const base = fs.mkdtempSync(path.join(runtime.BASE, "concurrency-"));
  try {
    runtime.atomic(path.join(base, "state.json"), JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8")));
    await Promise.all(
      Array.from({ length: 24 }, (_, index) => {
        const child = run(process.execPath, [script, "update", "--session", base]);
        child.child.stdin.end(JSON.stringify({ tasks: [{ id: String(index), title: String(index), status: "todo" }] }));
        return child;
      }),
    );
    const state = runtime.read(path.join(base, "state.json"));
    assert.equal(state.tasks.length, 24);
    assert.equal(state.revision, 24);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("removing a task requires updating its milestone", () => {
  runtime.update(root, { tasks: [{ id: "a", title: "A", status: "todo" }], milestones: [{ id: "m", title: "M", taskIds: ["a"] }] });
  assert.throws(() => runtime.update(root, { removeTasks: ["a"] }));
  assert.deepEqual(runtime.update(root, { removeTasks: ["a"], milestones: [] }).tasks, []);
});

test("export embeds data without script injection", () => {
  fs.copyFileSync(path.join(runtime.SKILL, "assets", "dashboard.html"), path.join(root, "template.html"));
  fs.copyFileSync(path.join(runtime.SKILL, "assets", "font.css"), path.join(root, "font.css"));
  fs.cpSync(path.join(runtime.SKILL, "components"), path.join(root, "components"), { recursive: true });
  fs.writeFileSync(path.join(root, "custom.js"), "// Custom view.\n");
  const attack = "</script><script>window.injected=true</script>";
  runtime.update(root, { title: attack });
  const html = runtime.render(root);
  assert.ok(!html.includes(attack));
  assert.ok(html.includes("\\u003c/script>"));
  assert.ok(!html.includes("/*__STATE__*/"));
});

test("session keys stay inside the dashboard root", () => {
  for (const key of ["../outside", "/tmp/not-a-dashboard-session", ""]) {
    assert.throws(() => runtime.session(key));
  }
});

test("library publishing detects conflicts and leaves session copies alone", () => {
  const skill = path.join(root, "skill");
  const components = path.join(skill, "components");
  fs.cpSync(path.join(runtime.SKILL, "components"), components, { recursive: true });
  const sessionCopy = path.join(root, "session-components");
  fs.cpSync(components, sessionCopy, { recursive: true });
  const source = path.join(root, "example.js");
  fs.writeFileSync(source, "window.DashboardComponents.example = () => document.createElement('p');\n");
  const catalog = path.join(root, "CATALOG.md");
  fs.writeFileSync(catalog, fs.readFileSync(path.join(components, "CATALOG.md"), "utf8") + "\nexample.js: example() creates a paragraph.\n");
  const baseline = library.digest(components);
  const result = library.publish(source, catalog, baseline, skill);
  assert.notEqual(result.digest, baseline);
  assert.ok(!fs.existsSync(path.join(sessionCopy, "example.js")));
  const before = fs.readFileSync(path.join(components, "example.js"));
  fs.writeFileSync(source, "window.DashboardComponents.example = () => document.createElement('b');\n");
  assert.throws(() => library.publish(source, catalog, baseline, skill), /Library changed/);
  assert.deepEqual(fs.readFileSync(path.join(components, "example.js")), before);
  fs.writeFileSync(source, "window.broken = (;\n");
  assert.throws(() => library.publish(source, catalog, result.digest, skill), /syntax check failed/);
});
