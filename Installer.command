#!/bin/sh
cd -- "$(dirname -- "$0")" || exit 1
if ! command -v python3 >/dev/null; then
    printf '%s\n' "Python 3 is required. Install Python 3 for macOS, then run this file again."
    exit 1
fi
exec python3 install.py "$@"
