#!/usr/bin/env bash
# Drive panes/prompt.mjs through a real PTY and assert how it reacts to keys.
#
# The bug this exists for: an arrow key sends ESC [ B. Reading a single byte
# left a bare ESC, which the handler treated as "Esc = decline" and the prompt
# vanished. Simulating keys with a shell pipe cannot catch that, because the
# bytes have to arrive the way a terminal sends them.
#
#   bash tests/prompt-keys.sh
set -uo pipefail

export WTDC_PLUGIN_ROOT="${WTDC_PLUGIN_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"

fail=0
check() {
  if [ "$2" = "$3" ]; then
    printf '  \033[32mPASS\033[0m %s\n' "$1"
  else
    printf '  \033[31mFAIL\033[0m %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"
    fail=$((fail + 1))
  fi
}

# drive <label> <python-bytes-literal> -> prints "alive|frames" summary
drive() {
  python3 - "$1" "$2" <<'PY'
import os, pty, select, shutil, signal, sys, time

label, keys = sys.argv[1], sys.argv[2].encode().decode("unicode_escape").encode("latin-1")
PLUGIN_ROOT = os.environ["WTDC_PLUGIN_ROOT"]
base = "/tmp/wtdc-prompt-test"
shutil.rmtree(base, ignore_errors=True)
os.makedirs(base + "/wt/.devcontainer", exist_ok=True)
os.makedirs(base + "/bin", exist_ok=True)
open(base + "/wt/.devcontainer/devcontainer.json", "w").write('{"name":"demo"}')
open(base + "/bin/herdr", "w").write('#!/usr/bin/env bash\nexit 0\n')
os.chmod(base + "/bin/herdr", 0o755)

env = dict(os.environ)
env.update({
    "HERDR_PLUGIN_ROOT": PLUGIN_ROOT,
    "HERDR_PLUGIN_ID": "worktree-devcontainer",
    "HERDR_PLUGIN_STATE_DIR": base + "/state",
    "HERDR_PLUGIN_CONFIG_DIR": base + "/config",
    "WTDC_CHECKOUT": base + "/wt",
    "WTDC_WORKSPACE": "w1",
    "WTDC_LABEL": "demo",
    "WTDC_REPO": "repo",
    "PATH": base + "/bin:" + env["PATH"],
})

pid, fd = pty.fork()
if pid == 0:
    os.execvpe("node", ["node", PLUGIN_ROOT + "/panes/prompt.mjs"], env)

buf = b""
def pump(sec):
    global buf
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return
            if not chunk:
                return
            buf += chunk

# Keys are written as chunks split on "|", each chunk in a single write, the
# way a terminal actually delivers them: an arrow key is one ESC [ B burst, not
# three separate keystrokes. Writing the bytes one at a time with gaps would
# test something no real terminal does.
for chunk in keys.split(b"|"):
    if not chunk:
        continue
    try:
        os.write(fd, chunk)
    except OSError:
        break
    pump(0.5)
pump(0.6)

# Is the process still alive and still drawing the prompt?
alive = True
try:
    done, _ = os.waitpid(pid, os.WNOHANG)
    alive = done == 0
except ChildProcessError:
    alive = False
if alive:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
try:
    os.close(fd)
except OSError:
    pass

text = buf.decode("utf-8", "replace")
frames = text.count("Create a dev container for this worktree")
print("alive" if alive else "exited", frames)
PY
}

printf 'prompt key handling\n'

out="$(drive 'down-arrow' '\x1b[B')"
check 'down arrow does not dismiss the prompt' 'alive' "$(echo "$out" | cut -d' ' -f1)"

out="$(drive 'up-arrow' '\x1b[A')"
check 'up arrow does not dismiss the prompt' 'alive' "$(echo "$out" | cut -d' ' -f1)"

out="$(drive 'right-arrow' '\x1b[C')"
check 'right arrow does not dismiss the prompt' 'alive' "$(echo "$out" | cut -d' ' -f1)"

out="$(drive 'left-arrow-then-y' '\x1b[D')"
check 'left arrow does not dismiss the prompt' 'alive' "$(echo "$out" | cut -d' ' -f1)"

out="$(drive 'f1-key' '\x1bOP')"
check 'function key does not dismiss the prompt' 'alive' "$(echo "$out" | cut -d' ' -f1)"

out="$(drive 'bare-esc' '\x1b')"
check 'bare esc declines' 'exited' "$(echo "$out" | cut -d' ' -f1)"

out="$(drive 'n' 'n')"
check 'n declines' 'exited' "$(echo "$out" | cut -d' ' -f1)"

out="$(drive 'y' 'y')"
check 'y accepts' 'exited' "$(echo "$out" | cut -d' ' -f1)"

out="$(drive 'enter' '\r')"
check 'enter accepts' 'exited' "$(echo "$out" | cut -d' ' -f1)"

printf 'checkbox toggling\n'
out="$(drive 'space' ' ')"
check 'space toggles and keeps the prompt open' 'alive' "$(echo "$out" | cut -d' ' -f1)"

out="$(drive 'space-then-down-arrow' ' |\x1b[B')"
check 'arrow after a toggle still does not dismiss' 'alive' "$(echo "$out" | cut -d' ' -f1)"

printf '\n'
if [ "$fail" -eq 0 ]; then
  printf '\033[32mall prompt key checks passed\033[0m\n'
else
  printf '\033[31m%d prompt key check(s) failed\033[0m\n' "$fail"
fi
exit "$fail"
