#!/usr/bin/env node
// A single interactive shell inside the provisioned container.
//
// This is the container terminal the `provision` action opens when no setup screen is
// on screen to become one. The dispatcher (lib/wtdc/shell.mjs) handles every terminal
// opened afterwards, including splits and new tabs, so this only has to cover the first
// one. See panes/boot.mjs for the other route in.

import { get as stateFor } from "../lib/wtdc/state.mjs";
import { enterContainerShell } from "../lib/wtdc/containerShell.mjs";

// This pane is opened with the container's details rather than looked up, so it works
// for a worktree whose state has not been written yet.
const entry = {
  checkout_path: process.env.WTDC_CHECKOUT || "",
  container_id: process.env.WTDC_CONTAINER_ID || "",
  container_workspace: process.env.WTDC_CONTAINER_WORKSPACE || "",
  remote_user: process.env.WTDC_CONTAINER_USER || "",
};

const label = process.env.WTDC_LABEL || entry.container_id.slice(0, 12);
if (!entry.container_id) {
  process.stdout.write("error: no dev container id was supplied\n");
  process.exit(1);
}

// Prefer the recorded entry, so the argv is the dispatcher's own even when this pane
// was opened from a slightly different set of values.
const recorded = entry.checkout_path ? stateFor(entry.checkout_path) : null;
const plan = recorded || entry;

process.exit(
  enterContainerShell(plan, entry.checkout_path, {
    label,
    note: "Connected with docker exec. Exit to close this tab.",
  }),
);
