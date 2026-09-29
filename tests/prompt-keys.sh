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

# The stub the launcher is expected to reach, shared with the python driver below.
BASE=/tmp/wtdc-prompt-test

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
open(base + "/wt/.devcontainer/devcontainer.json", "w").write(
    '{"name":"demo","image":"debian:12","postCreateCommand":"echo ok"}')
# The stub records that it was called, so the test can tell "the launcher was stubbed"
# from "the launcher never ran at all".
open(base + "/bin/herdr", "w").write('#!/usr/bin/env bash\necho "$*" >> "' + base + '/calls"\nexit 0\n')
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
# The stub on PATH is not enough: lib/wtdc/context.mjs prefers HERDR_BIN_PATH, and that
# is set in any pane this test is likely to be run from. Left alone, the launcher that
# "y" spawns opens a real setup screen over whatever pane is focused, and runs a real
# `devcontainer up` against the fixture — which is why this test was flaky, and why it
# could leave a build screen on someone's terminal.
env["HERDR_BIN_PATH"] = base + "/bin/herdr"

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

# Is the process still alive and still drawing the prompt? A prompt that was supposed to
# dismiss gets a moment to actually exit rather than a fixed guess: on a loaded machine
# "has not exited yet" and "stays on screen" look identical, and the second one is the
# bug this whole file exists for.
def exited_within(sec):
    end = time.time() + sec
    while time.time() < end:
        try:
            done, _ = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return True
        if done != 0:
            return True
        pump(0.1)
    return False

dismissed = b"\x1b" in keys or b"n" in keys or b"y" in keys or b"\r" in keys
alive = not (dismissed and exited_within(5))
if alive:
    try:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError):
        pass
try:
    os.close(fd)
except OSError:
    pass

text = buf.decode("utf-8", "replace")
frames = text.count("Create a dev container for this worktree")

# An accepted prompt spawns boot-launch detached, so it is still starting up when the
# prompt itself has already exited. Wait for it here rather than in the caller: the
# shell has no way to tell an accepting drive from a declining one, and a check that
# races a detached process is a check that reports whatever it happened to see.
if "starting dev container" in text:
    deadline = time.time() + 10
    while time.time() < deadline and not os.path.exists(base + "/calls"):
        time.sleep(0.1)

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

printf 'the launcher is stubbed out\n'
# Answering yes spawns boot-launch, which opens the setup screen. That has to reach the
# stub: a test that quietly opens a real pane over the user's focused one and starts a
# real build is worse than no test at all. Each drive wipes the sandbox, so this has to be
# a drive of its own, and one that actually accepts.
drive 'y' 'y' >/dev/null
check 'the stub launcher was called, not the real herdr' 'yes' \
  "$([ -s "$BASE/calls" ] && echo yes || echo no)"
check 'it asked for the setup screen by name' 'yes' \
  "$(grep -q 'entrypoint boot' "$BASE/calls" 2>/dev/null && echo yes || echo no)"

# A prompt that quotes a plan the user has already replaced is not a stale frame, it is a
# wrong answer — and editing devcontainer.json while the question is open is the ordinary
# way to find out what a change does. So the dialog has to notice the file changing.
# Driven by editing the file from a second process while the prompt sits there.
printf 'the image field\n'
# Focus starts on the answer, so the keys that answer it still work immediately, and
# reaching the image is a deliberate move up. Getting this backwards would mean a dialog
# that cannot be declined, because `n` would type into a text field.
field="$(python3 - <<'PY'
import os, pty, re, select, time

PLUGIN_ROOT = os.environ["WTDC_PLUGIN_ROOT"]
base = "/tmp/wtdc-prompt-test"

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
    "HERDR_BIN_PATH": base + "/bin/herdr",
})

pid, fd = pty.fork()
if pid == 0:
    os.execvpe("node", ["node", PLUGIN_ROOT + "/panes/prompt.mjs"], env)

buf = b""
def pump(sec):
    global buf
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return
            if not chunk:
                return
            buf += chunk

def send(data, wait=0.4):
    os.write(fd, data)
    pump(wait)

def frame():
    text = re.sub(r"\x1b\[[0-9;]*m", "", buf.decode("utf-8", "replace"))
    return text.split("\x1b[2J\x1b[H")[-1]

pump(2.5)
out = []
out.append("answer-first" if "y/" in frame() and "Create a dev container" in frame() else "answer-lost")

send(b"\x1b[A")                                   # up, onto the image
out.append("edit-mode" if "type to edit" in frame() else "no-edit")

send(b"\x15")                                     # ctrl-u clears the field
out.append("cleared" if "debian:12" not in frame() else "not-cleared")

send(b"example.invalid/x:1", wait=0.3)
out.append("typed" if "example.invalid/x:1" in frame() else "not-typed")
out.append("marked" if "edited in this dialog" in frame() else "not-marked")

send(b"\x1b")                                     # esc puts the config's image back
pump(1.0)
out.append("reverted" if "debian:12" in frame() else "not-reverted")
out.append("still-open" if "Create a dev container" in frame() else "dismissed")

os.write(fd, b"n")
time.sleep(0.3)
print(" ".join(out))
PY
)"
check 'the image field is reachable and editable' \
  'answer-first edit-mode cleared typed marked reverted still-open' "$field"

printf 'the mounts a config declares are shown\n'
mounts="$(python3 - <<'PY'
import os, pty, re, select, time

PLUGIN_ROOT = os.environ["WTDC_PLUGIN_ROOT"]
base = "/tmp/wtdc-prompt-test"
cfg = base + "/wt/.devcontainer/devcontainer.json"

# Two forms, and the difference between them: a bind that is read-only and a bind that is
# not. The second is the one that matters — it means anything in the container can change
# a file of yours, because the container user has the same uid as you.
open(cfg, "w").write("""{
  "image": "debian:12",
  "mounts": [
    "type=bind,source=/usr/bin/btop,target=/usr/local/bin/btop,readonly",
    { "type": "bind", "source": "/home/u/notes", "target": "/notes" }
  ]
}""")

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
    "HERDR_BIN_PATH": base + "/bin/herdr",
})

pid, fd = pty.fork()
if pid == 0:
    os.execvpe("node", ["node", PLUGIN_ROOT + "/panes/prompt.mjs"], env)

buf = b""
def pump(sec):
    global buf
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return
            if not chunk:
                return
            buf += chunk

pump(2.5)
text = re.sub(r"\x1b\[[0-9;]*m", "", buf.decode("utf-8", "replace")).split("\x1b[2J\x1b[H")[-1]
out = []
out.append("ro" if "btop" in text and "read-only" in text else "no-ro")
out.append("wr" if "/notes" in text and "writable from inside" in text else "no-wr")
out.append("target" if "/usr/local/bin/btop" in text else "no-target")
os.write(fd, b"n")
time.sleep(0.3)
print(" ".join(out))
PY
)"
check 'a read-only bind and a writable one are both named, and told apart' \
  'ro wr target' "$mounts"

printf 'the prompt follows the config it is describing\n'
watch="$(python3 - <<'PY'
import os, pty, re, select, time

PLUGIN_ROOT = os.environ["WTDC_PLUGIN_ROOT"]
base = "/tmp/wtdc-prompt-test"
cfg = base + "/wt/.devcontainer/devcontainer.json"

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
    # Keep the launcher stubbed: this is about what is drawn, not what runs.
    "HERDR_BIN_PATH": base + "/bin/herdr",
})

pid, fd = pty.fork()
if pid == 0:
    os.execvpe("node", ["node", PLUGIN_ROOT + "/panes/prompt.mjs"], env)

buf = b""
def pump(sec):
    global buf
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return
            if not chunk:
                return
            buf += chunk

pump(3)
before = open(cfg).read()
# Swap the image — the one field the dialog renders from this file, so its absence from a
# later frame means the dialog is quoting a plan the user has already replaced.
edited = re.sub(r'"image"\s*:\s*"[^"]*"', '"image": "example.invalid/edited:latest"', before)
assert edited != before, "the fixture has no image to swap"
open(cfg, "w").write(edited)
pump(4)
os.write(fd, b"n")
time.sleep(0.3)
open(cfg, "w").write(before)

text = re.sub(r"\x1b\[[0-9;]*m", "", buf.decode("utf-8", "replace"))
print("fresh" if "edited:latest" in text else "stale")
PY
)"
check 'the prompt re-reads a config that changed under it' 'fresh' "$watch"

# The scratch directory is fixed rather than per-run so the three drivers above can share
# one stub, which means nothing sweeps it up on its own. Left behind, it is a directory in
# /tmp that belongs to a test that has finished.
rm -rf "$BASE"

printf '\n'
if [ "$fail" -eq 0 ]; then
  printf '\033[32mall prompt key checks passed\033[0m\n'
else
  printf '\033[31m%d prompt key check(s) failed\033[0m\n' "$fail"
fi
exit "$fail"
