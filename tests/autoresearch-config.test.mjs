import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import {
  DEFAULT_MAX_AUTORESUME_TURNS,
  readIterationTimeoutSeconds,
  readMaxAutoResumeTurns,
} from "../extensions/pi-autoresearch/index.ts";

function withConfig(config, fn) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "pi-autoresearch-config-"));
  try {
    if (config !== undefined) {
      fs.writeFileSync(path.join(dir, "autoresearch.config.json"), JSON.stringify(config));
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("iterationTimeoutSeconds is read as a positive integer", () => {
  withConfig({ iterationTimeoutSeconds: 14400.9 }, (dir) => {
    assert.equal(readIterationTimeoutSeconds(dir), 14400);
  });

  withConfig({ iterationTimeoutSeconds: 0 }, (dir) => {
    assert.equal(readIterationTimeoutSeconds(dir), null);
  });
});

test("maxAutoResumeTurns defaults to 20 and supports unlimited with null or 0", () => {
  withConfig(undefined, (dir) => {
    assert.equal(readMaxAutoResumeTurns(dir), DEFAULT_MAX_AUTORESUME_TURNS);
  });

  withConfig({ maxAutoResumeTurns: null }, (dir) => {
    assert.equal(readMaxAutoResumeTurns(dir), null);
  });

  withConfig({ maxAutoResumeTurns: 0 }, (dir) => {
    assert.equal(readMaxAutoResumeTurns(dir), null);
  });

  withConfig({ maxAutoResumeTurns: 7.8 }, (dir) => {
    assert.equal(readMaxAutoResumeTurns(dir), 7);
  });
});
