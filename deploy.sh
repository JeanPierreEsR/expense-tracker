#!/bin/bash
# RETIRED. deploy.sh used to publish everything in the folder it was run from,
# which also published other chats' unfinished work. Use ship.sh instead:
#   ./ship.sh <branch> "commit message"            (from the main folder)
#   ./ship.sh --dry-run                            (safe preview, from anywhere)
echo "deploy.sh is retired — use ./ship.sh (see CLAUDE.md §4 'Parallel chats')." >&2
exit 1
