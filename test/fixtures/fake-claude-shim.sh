#!/bin/sh
# Like a terminal-wrapper shim: runs fake-claude as a child WITHOUT exec, so the real work
# happens in a grandchild of the curator runner.
"$(dirname "$0")/fake-claude.mjs" "$@"
status=$?
exit $status
