import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTORESEARCH_BRANCH,
  ensureAutoresearchBranch,
} from "../extensions/pi-autoresearch/index.ts";

function result(code = 0, stdout = "", stderr = "") {
  return { code, stdout, stderr };
}

function mockPi(responses) {
  const calls = [];

  return {
    calls,
    async exec(command, args, options) {
      calls.push({ command, args, options });
      const key = args.join(" ");
      const response = responses[key];
      if (!response) {
        throw new Error(`unexpected command: ${command} ${key}`);
      }
      return response;
    },
  };
}

test("ensureAutoresearchBranch does nothing when already on autoresearch", async () => {
  const pi = mockPi({
    "rev-parse --is-inside-work-tree": result(0, "true\n"),
    "branch --show-current": result(0, `${AUTORESEARCH_BRANCH}\n`),
  });

  const branch = await ensureAutoresearchBranch(pi, "/repo");

  assert.deepEqual(branch, { ok: true, action: "already_on" });
  assert.deepEqual(pi.calls.map((call) => call.args), [
    ["rev-parse", "--is-inside-work-tree"],
    ["branch", "--show-current"],
  ]);
});

test("ensureAutoresearchBranch creates autoresearch when missing", async () => {
  const pi = mockPi({
    "rev-parse --is-inside-work-tree": result(0, "true\n"),
    "branch --show-current": result(0, "main\n"),
    "show-ref --verify --quiet refs/heads/autoresearch": result(1),
    "switch -c autoresearch": result(0),
  });

  const branch = await ensureAutoresearchBranch(pi, "/repo");

  assert.deepEqual(branch, { ok: true, action: "created" });
});

test("ensureAutoresearchBranch switches to autoresearch when it exists", async () => {
  const pi = mockPi({
    "rev-parse --is-inside-work-tree": result(0, "true\n"),
    "branch --show-current": result(0, "main\n"),
    "show-ref --verify --quiet refs/heads/autoresearch": result(0),
    "switch autoresearch": result(0),
  });

  const branch = await ensureAutoresearchBranch(pi, "/repo");

  assert.deepEqual(branch, { ok: true, action: "switched" });
});

test("ensureAutoresearchBranch reports Git worktree failures", async () => {
  const pi = mockPi({
    "rev-parse --is-inside-work-tree": result(128, "", "not a git repository"),
  });

  const branch = await ensureAutoresearchBranch(pi, "/repo");

  assert.equal(branch.ok, false);
  assert.match(branch.message, /requires a Git worktree/);
});
