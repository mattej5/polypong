#!/bin/bash
# Polypong launcher.
#
# Starts the classroom server, opens the teacher console, and holds a dialog
# open as the stop button. Quitting the dialog stops the server.
#
# Unlike the previous version, this bundle is SELF-CONTAINED: the server is a
# compiled binary inside Contents/Resources. There is no Node to find, no repo
# directory to keep in place, and no dependencies to install. Moving or
# renaming any folder on this Mac cannot break it.

HERE="$(cd "$(dirname "$0")/../Resources" && pwd)"
PORT=5080

say() {
  osascript -e "display dialog \"$1\" buttons {\"OK\"} default button 1 with title \"Polypong\" with icon caution" >/dev/null 2>&1
}

# Ask the HARDWARE, not the process. A bundle launched through LaunchServices
# can end up translated, and `uname -m` then reports x86_64 on an Apple Silicon
# Mac -- which silently runs the Intel build under Rosetta on a machine that
# has a native one sitting beside it. `hw.optional.arm64` reports the real
# chip either way. (Observed: this launcher picked the x64 binary on an M4.)
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then
  BIN="$HERE/polypong-arm64"
else
  BIN="$HERE/polypong-x64"
fi

if [ ! -x "$BIN" ]; then
  say "Polypong is missing its program file. Try downloading or rebuilding the app."
  exit 1
fi

# The server binds one fixed port, because that port is written on the
# classroom board. A stale copy still listening is the likely cause, so say so
# in those words rather than reporting a port conflict.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  say "Polypong is already running on this Mac. Look for the other Polypong window and click Stop Server there, then try again."
  exit 1
fi

"$BIN" >/tmp/polypong.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; exit 0' EXIT INT TERM

for _ in $(seq 1 40); do
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && break
  sleep 0.25
done

if ! kill -0 $SERVER 2>/dev/null; then
  say "The Polypong server could not start. Details are in /tmp/polypong.log"
  exit 1
fi

IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo localhost)

# The server opens the teacher console itself. This dialog exists to hold the
# process open and to put the join address somewhere the teacher can read it
# while walking to the board.
osascript >/dev/null 2>&1 <<OSA
display dialog "Polypong is running.

Students join on this Wi-Fi at:
    $IP:$PORT/play

The teacher console has opened in your browser. Put that window on the projector.

If no student can connect, check the network first:
    $IP:$PORT/health

Click Stop Server when class is over." buttons {"Stop Server"} default button 1 with title "Polypong"
OSA

kill $SERVER 2>/dev/null
exit 0
