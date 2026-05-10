import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_EXPERIMENT_TIMEOUT_SECONDS,
  DEFAULT_MAX_AUTORESUME_TURNS,
  buildDiscardRevertScript,
  readIterationTimeoutSeconds,
  readMaxAutoResumeTurns,
} from "../extensions/pi-autoresearch/index.ts";

test("autoresearch config reads iteration timeout seconds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-autoresearch-config-"));
  try {
    assert.equal(readIterationTimeoutSeconds(dir), null);

    await writeFile(
      join(dir, "autoresearch.config.json"),
      JSON.stringify({ iterationTimeoutSeconds: 14400 }),
    );

    assert.equal(readIterationTimeoutSeconds(dir), 14400);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("autoresearch config reads max auto resume turns with zero/null as unlimited", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-autoresearch-config-"));
  try {
    assert.equal(readMaxAutoResumeTurns(dir), DEFAULT_MAX_AUTORESUME_TURNS);

    await writeFile(
      join(dir, "autoresearch.config.json"),
      JSON.stringify({ maxAutoResumeTurns: 8 }),
    );
    assert.equal(readMaxAutoResumeTurns(dir), 8);

    await writeFile(
      join(dir, "autoresearch.config.json"),
      JSON.stringify({ maxAutoResumeTurns: 0 }),
    );
    assert.equal(readMaxAutoResumeTurns(dir), null);

    await writeFile(
      join(dir, "autoresearch.config.json"),
      JSON.stringify({ maxAutoResumeTurns: null }),
    );
    assert.equal(readMaxAutoResumeTurns(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discard cleanup preserves autoresearch files and experiments folder", () => {
  const script = buildDiscardRevertScript();

  assert.match(script, /git checkout -- \./);
  assert.match(script, /git clean -fd/);
  assert.match(script, /autoresearch\.\*/);
  assert.match(script, /experiments/);
  assert.match(script, /:\(exclude,glob\)experiments\/\*\*/);
  assert.match(script, /-e 'experiments'/);
  assert.match(script, /-e 'experiments\/\*\*'/);
  assert.equal(script.includes(String(DEFAULT_EXPERIMENT_TIMEOUT_SECONDS)), false);
});
