import assert from "node:assert/strict";
import test from "node:test";
import {
  barCells,
  DockerPullProgress,
  PHASES,
  isProgressLine,
  outputRows,
  parseProgressLine,
  phaseStart,
} from "../lib/wtdc/progress.mjs";

test("Docker layer updates advance a stable setup bar", () => {
  const pull = new DockerPullProgress();
  assert.equal(pull.update("abc: Pulling fs layer"), 0);
  assert.equal(pull.update("def: Pulling fs layer"), 0);
  const steps = [
    pull.update("abc: Downloading [==>] 10MB/50MB"),
    pull.update("abc: Downloading [======>] 40MB/50MB"),
    pull.update("abc: Download complete"),
    pull.update("abc: Extracting 25MB/50MB"),
    pull.update("abc: Pull complete"),
    pull.update("def: Already exists"),
  ];
  assert.deepEqual(
    steps.map((part) => Number(part.toFixed(2))),
    [0.08, 0.32, 0.4, 0.45, 0.5, 1],
  );
  assert.equal(pull.update("Status: Downloaded newer image"), null);
  assert.ok(pull.update("abc: Downloading 1MB/50MB") >= 1);
  const filled = steps.map((part) => barCells(10 + 25 * part, 34));
  assert.deepEqual(filled, [4, 6, 7, 7, 8, 12]);
  assert.ok(filled.every((value, index) => index === 0 || value >= filled[index - 1]));
});

test("Docker carriage returns appear as separate progress updates", () => {
  const first = outputRows("", "layer: Downloading 10MB/50MB\rlayer: Downloading 40MB");
  assert.deepEqual(first.rows, ["layer: Downloading 10MB/50MB"]);
  const second = outputRows(first.partial, "/50MB\r\nlayer: Pull complete\n");
  assert.deepEqual(second.rows.filter(Boolean), [
    "layer: Downloading 40MB/50MB",
    "layer: Pull complete",
  ]);
  assert.equal(second.partial, "");
});

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
