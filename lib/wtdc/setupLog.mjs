import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { STATE_DIR } from "./context.mjs";

/** Keep the cause visible when a CLI error ends with a long stack trace. */
export function failureRows(lines, count) {
  const messages = lines.filter((line) => !/^\s*at\s/.test(line) && !/^Node\.js v/.test(line));
  return (messages.length ? messages : lines).slice(-count);
}

/** Stream the complete child output to a private file, independently of the UI tail. */
export function setupLog(checkout, directory = path.join(STATE_DIR, "logs")) {
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const hash = createHash("sha256").update(checkout).digest("hex").slice(0, 12);
    const file = path.join(directory, `setup-${hash}-${Date.now()}-${process.pid}.log`);
    fs.writeFileSync(file, "", { flag: "wx", mode: 0o600 });
    return {
      file,
      append(chunk) {
        try {
          fs.appendFileSync(file, chunk);
        } catch {
          /* Logging must not fail setup. */
        }
      },
    };
  } catch {
    return null;
  }
}
