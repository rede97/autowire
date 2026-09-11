#!/usr/bin/env bash
# Apply local IP patches. Patches in this directory are the SoT; submodules
# stay pristine upstream. Run after `git submodule update --init`.
# Idempotent: skips already-applied patches, fails if the tree diverged.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)

cd "$HERE/../ip/sdspi"
if git apply --reverse --check "$HERE/sdspi-fifo-wb-once.patch" 2>/dev/null; then
	echo "already applied: sdspi-fifo-wb-once.patch"
elif git apply --check "$HERE/sdspi-fifo-wb-once.patch" 2>/dev/null; then
	git apply "$HERE/sdspi-fifo-wb-once.patch"
	echo "applied: sdspi-fifo-wb-once.patch"
else
	echo "ERROR: sdspi-fifo-wb-once.patch does not apply" >&2
	echo "  (submodule not at upstream dfb16c8? run: git submodule update --init)" >&2
	exit 1
fi
