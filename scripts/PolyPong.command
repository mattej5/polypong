#!/usr/bin/env bash
# Double-clicked by the teacher. Picks the binary for this Mac and runs it.
cd "$(dirname "$0")"
# Ask the hardware, not the process: `uname -m` reports x86_64 when the shell
# itself is translated, which silently selects the Intel build on an Apple
# Silicon Mac that has a native one right beside it.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then
  BIN=./polypong-arm64
else
  BIN=./polypong-x64
fi
if [ ! -x "$BIN" ]; then
  echo "PolyPong is missing its program file ($BIN)."
  echo "Copy the whole folder, not just this icon."
  read -r -p "Press return to close."
  exit 1
fi
exec "$BIN"
