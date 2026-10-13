# Hoardware

*Know what you own, where it is, and whether it works.*

A self-hosted inventory for a hardware collection (CPUs, graphics cards, motherboards, sound cards, RAM, drives…). Built to find any part in seconds, at any collection size, with no cloud dependency. The full design is in [HOARDWARE_SPEC.md](HOARDWARE_SPEC.md).

| Service    | Technology                                             |
| ---------- | ------------------------------------------------------ |
| `db`       | PostgreSQL 18                                          |
| `backend`  | Python, FastAPI, SQLAlchemy 2, Alembic, Pydantic       |
| `frontend` | Next.js (App Router), Tailwind CSS, shadcn/ui          |

Only the frontend publishes a port. The backend API and database exist solely on the internal Compose network; the browser reaches the API through the Next.js proxy at `/api/v1/*`.

## Quick start

```bash
cp .env.example .env     # optional; every value has a working default
docker compose up -d --build
```

Open <http://localhost:3000> (change `FRONTEND_PORT` in `.env` if 3000 is taken). Migrations run automatically when the backend starts, and the default categories (CPU, GPU/VGA, Motherboard, Sound Card, RAM, Storage, Other) are seeded.

Everyday use needs no internet access. (Building the images does.)

### Keyboard shortcuts

| Key | Action                                            |
| --- | ------------------------------------------------- |
| `/` | Focus search                                      |
| `n` | Quick add (Enter = save and add another)          |
| `Ctrl/⌘ + S` | Save on the item page                    |

## Using it

- **Inventory**: instant search across code, manufacturer, model, part number, chipset and notes; filter by category, manufacturer, condition, test status, identification and location (with or without sub-locations); sort by latest, name, category or location. Filters live in the URL, so a search can be bookmarked.
- **Quick add**: only a category and a description are required. Category and location are remembered between additions.
- **Test status vs condition**: independent. `Unknown` means testing is currently impossible (note why in *Test notes*); `Untested` means not tried yet.
- **Every physical item is its own record** with its own code (`HW-000001`, never reused), so identical parts can differ in location, condition and test result.
- **Locations**: a tree (`Workshop > Shelf 2 > CPU Box 3`); moving or renaming a location updates everything inside it.
- **CSV export**: the **CSV** button exports the current filter (streamed, so it works at any size).

## Photo storage

Photos are stored outside the database. Two backends, chosen with `STORAGE_BACKEND`:

- `local` (default): the `photos` Docker volume.
- `s3`: any S3-compatible service (AWS S3, RustFS, MinIO, Backblaze B2, Cloudflare R2…).

```env
STORAGE_BACKEND=s3
S3_ENDPOINT_URL=http://your-s3-host:9000   # empty for AWS S3
S3_REGION=us-east-1
S3_BUCKET=hoardware                        # must already exist
S3_PREFIX=photos/
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=true                   # true for most self-hosted services
```

The bucket stays private: the backend streams photos itself. If the S3 service runs outside this Compose project, the `backend` container must be able to reach `S3_ENDPOINT_URL` (use the host's LAN address, or `host.docker.internal`).

The database stores only backend-independent keys. To switch backends with existing photos:

```bash
docker compose run --rm --no-deps backend python -m app.cli migrate-photos --from local --to s3
# then set STORAGE_BACKEND=s3 in .env and: docker compose up -d
```

Add `--delete-source` to remove each object from the old backend after it has been copied. If an object cannot be deleted when a photo or item is removed (storage outage), it is queued and retried with `python -m app.cli storage-gc`.

## Backups and restore

CSV export is **not** a backup. A full backup is **the database plus the photos**, and the two should be restored together.

### Database

```bash
docker compose run --rm --no-deps backend python -m app.cli backup         # pg_dump to the "backups" volume
docker compose run --rm --no-deps backend python -m app.cli list-backups
```

Set `BACKUP_S3_BUCKET` (and optionally `BACKUP_S3_PREFIX`, `BACKUP_S3_ENDPOINT_URL`, `BACKUP_S3_REGION`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`; unset ones fall back to `S3_*`) and every backup is also uploaded to S3. The newest `BACKUP_RETENTION_COUNT` (default 14) are kept on each destination.

Scheduled backups every `BACKUP_INTERVAL_HOURS` (default 24):

```bash
docker compose --profile backup up -d
```

**Restore** (replaces the current database contents):

```bash
docker compose stop frontend backend
docker compose run --rm --no-deps backend python -m app.cli list-backups
docker compose run --rm --no-deps backend python -m app.cli restore hoardware-20261013T120000Z.dump
# from S3 instead of the local volume:  ... restore <name> --source s3
docker compose start backend frontend
```

Dumps are standard PostgreSQL custom-format files, so `pg_restore` works on them directly too. Copying a dump out of the volume:

```bash
docker run --rm -v hoardware_backups:/b -v "$PWD":/out busybox cp -a /b/. /out/
```

### Photos

- **Local volume**: archive the `photos` volume.

  ```bash
  docker run --rm -v hoardware_photos:/data -v "$PWD":/out busybox tar czf /out/photos.tgz -C /data .
  ```

  Restore by extracting into an empty `photos` volume the same way (`tar xzf`).
- **S3**: use your S3 service's own durability features (versioning, replication). Hoardware only writes to the bucket and deletes what you delete.

Volume names are prefixed with the Compose project name (`hoardware_` by default).

## Reference data (optional)

Hoardware works fully without this. If you want, an item can be matched to a described model (specs from a public dataset) so you don't have to type them in. Matching never changes your own fields, never links automatically, and can be undone with **Unlink**.

CPU-DB (<https://github.com/zymos/cpu-db>) is supported. Put a checkout (or just the `cpu-db.<Vendor>.csv` files) in `./reference-data/cpu-db/` (git-ignored; mounted read-only into the backend at `/reference-data`), then:

```bash
docker compose run --rm --no-deps backend python -m app.cli import-reference cpu-db /reference-data/cpu-db --dry-run   # report only
docker compose run --rm --no-deps backend python -m app.cli import-reference cpu-db /reference-data/cpu-db
```

The import is repeatable: re-running reports `added / changed / unchanged / skipped / errors`, updates records in place (so existing links survive) and never deletes records. Findings about the dataset's quirks, and why the GPU datasets are not imported, are in [docs/reference-data-findings.md](docs/reference-data-findings.md).

On an item page, **Find reference match** suggests models by part number (including codes such as an S-Spec) and name; you choose **Confirm match** or **Mark as candidate**.

## Development

```bash
# backend tests (real PostgreSQL; creates a throwaway <db>_test database next to the app's)
docker compose up -d db
docker compose run --rm --no-deps backend pytest

# frontend
cd frontend && npm install && npm run lint && npx tsc --noEmit

# browser smoke tests against the running stack (Playwright in a container)
cd e2e && npm install
docker run --rm --network hoardware_default -v "$PWD":/work -w /work \
  -e BASE_URL=http://frontend:3000 mcr.microsoft.com/playwright:v1.64.0-noble npx playwright test
```

The scale tests in `backend/tests/test_scale.py` seed 100,000 items and check query plans and latency.

### Layout

```
backend/    FastAPI app (app/), Alembic migrations (alembic/), tests (tests/)
frontend/   Next.js app (src/), API proxy at src/app/api/v1/[...path]/route.ts
e2e/        Playwright smoke tests
```

## API

Interactive docs: `/api/v1/docs` (through the frontend). Lists use cursor (keyset) pagination: pass the returned `next_cursor` back as `cursor`. Search and filtering run in SQL (PostgreSQL `pg_trgm` indexes).
