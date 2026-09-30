// Run Docker inspection outside the dialog so a busy daemon cannot block its keys.
import { loadConfig } from "./config.mjs";
import { describeFeatureCache } from "./devcontainer.mjs";

const [src, worktree, image] = process.argv.slice(2);
if (image) process.env.WTDC_OVERRIDE_IMAGE = image;
try {
  process.stdout.write(JSON.stringify(describeFeatureCache(src, loadConfig(), worktree)));
} catch (error) {
  process.stdout.write(JSON.stringify({ state: "error", reason: error.message }));
}
