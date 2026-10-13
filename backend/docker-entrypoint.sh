#!/bin/sh
set -e

# Apply migrations before serving. Skipped for one-off commands (CLI, pytest)
# unless RUN_MIGRATIONS=1 is set.
if [ "$1" = "uvicorn" ] || [ "$RUN_MIGRATIONS" = "1" ]; then
    alembic upgrade head
fi

exec "$@"
