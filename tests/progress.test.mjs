import assert from "node:assert/strict";
import test from "node:test";
import { PHASES, isProgressLine, parseProgressLine, phaseStart } from "../lib/wtdc/progress.mjs";

test("parses progress lines and keeps tabs in the message", () => {
  assert.equal(isProgressLine("WTDC_PROGRESS\tup\t42\tbuilding"), true);
  assert.deepEqual(parseProgressLine("WTDC_PROGRESS\tup\t42\tbuilding\timage"), {
    phase: "up",
    percent: 42,
    message: "building\timage",
  });
  assert.deepEqual(parseProgressLine("WTDC_PROGRESS\tdone\t100\t"), {
    phase: "done",
    percent: 100,
    message: "",
  });
});

test("rejects malformed progress lines", () => {
  for (const line of [
    "ordinary output",
    "WTDC_PROGRESS",
    "WTDC_PROGRESS\tup\t\tmessage",
    "WTDC_PROGRESS\tup\t   \tmessage",
    "WTDC_PROGRESS\tunknown\t42\tmessage",
    "WTDC_PROGRESS\tup\tNaN\tmessage",
    "WTDC_PROGRESS\tup\t-1\tmessage",
    "WTDC_PROGRESS\tup\t101\tmessage",
  ]) {
    assert.equal(parseProgressLine(line), null, line);
  }
});

test("phaseStart returns each phase's cumulative share", () => {
  let expected = 0;
  for (const phase of PHASES) {
    assert.equal(phaseStart(phase.key), expected);
    expected += phase.share;
  }
  assert.equal(phaseStart("unknown"), expected);
});
