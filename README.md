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
- **Category-specific item pages**: each category defines its own fields, so a CPU is described as a CPU (Family, Speed, Bus speed, L2 cache, Socket, Package, Stepping…) and a graphics card as a graphics card (Chipset maker, Chipset, Memory size, Bus…); chipset fields only appear where they make sense. The item page is a stack of clear sections: Overview, *Specifications* for its category, Condition & testing, Where it is, test history, with photos beside them and the secondary actions (add another like this, delete) in the **⋯** menu. Change a category's fields on the **Categories** page (*Fields*): add, rename, reorder, remove. The seven default categories start with sensible fields. Values you enter are the item's own specs (searchable, shown on the inventory row, in the CSV `specs` column); anything not covered by the category's fields appears under *Other specs*.
- **Quick add**: only a category and a description are required. Category and location are remembered between additions, and as you type it tells you if you already have matching items.
- **Status strip**: above the list, chips show how many items are Untested, Unknown, POST, Full Test or Dead (respecting your other filters); click one to filter.
- **Test history**: every change of an item's test status is logged automatically with the date and the notes in force at the time, and you can log a test by hand (result, date, what was tested). The item page shows the history and when it was last tested. Items created by CSV import start with no history.
- **Test status vs condition**: independent. `Unknown` means testing is currently impossible (note why in *Test notes*); `Untested` means not tried yet.
- **Every physical item is its own record** with its own code (`HW-000001`, never reused), so identical parts can differ in location, condition and test result.
- **Locations**: a tree (`Workshop > Shelf 2 > CPU Box 3`); moving or renaming a location updates everything inside it.
- **Exact location = location + position**: create a location, then locations inside it (each can have a free-text type: shelf, box, drawer…). An item's *Position* is its exact spot inside its location, and two items can't share one. Quick add with **Copies** = 10 and **Position** = 1 puts ten identical CPUs, as ten separate items, at positions 1–10; *Save & add another* carries on from 11. Sibling locations may share a name.
- **Stock-take**: each item records when it was last *verified* (seen in place). Tick what is physically there and press **Verified** in the bulk bar, then use the *Last verified* filter (or the *Stock-take* filter on a location's page) to list what has not been seen in 30/90/365 days, or never. **Print list** on a location's page gives a printable, position-ordered sheet with a tick box per item, grouped by sub-location, for checking on paper.
- **Bulk actions**: tick rows (shift-click selects a range, or *Select all N matching* for everything the filters match) and a bar appears: set the test status, condition, category or test notes, or **Move…** to a location. When moving you choose what happens to positions: clear them, number on after the last one in the destination, or keep them (refused if any would clash, with a count shown before you commit). On a location's page, **Move all items…** moves everything out of it.
- **CSV export and import**: the **CSV** button exports the current filter (streamed, so it works at any size). **Import** takes a CSV (the export's columns, a template is provided, and friendly header names such as `name`, `p/n` work too), checks every row first and shows the problems by line, and writes nothing until you confirm. It is all-or-nothing unless you tick *Skip rows with errors*; *Create missing categories/locations* fill in what the file refers to. Every row becomes a new item with a new code.

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

CPU-DB (<https://github.com/zymos/cpu-db>) is supported. Put a checkout (or just the `cpu-db.<Vendor>.csv` files) in `./reference-data/cpu-db/` (git-ignored; mounted read-only into the backend at `/reference-data`). If you also include `supplemental_db/cpu-db.supplemetal.Intel.S-Spec_numbers.csv`, Intel records gain the bus speed and any missing speed/cache/package, and about 1,200 more S-Specs become findable. Then:

```bash
docker compose run --rm --no-deps backend python -m app.cli import-reference cpu-db /reference-data/cpu-db --dry-run   # report only
docker compose run --rm --no-deps backend python -m app.cli import-reference cpu-db /reference-data/cpu-db
```

The import is repeatable: re-running reports `added / changed / unchanged / skipped / errors`, updates records in place (so existing links survive) and never deletes records. Findings about the dataset's quirks, and why the GPU datasets are not imported, are in [docs/reference-data-findings.md](docs/reference-data-findings.md).

**While adding a CPU:** open Quick add and type the code printed on the chip (an S-Spec such as `SL32A`, or an ordering code) into *Part number* or *Model*, or a name in a CPU category. A dropdown floats under the field with matching records, each showing a readable name, the full part number and the key specs (speed, bus, cache, package); nothing is filled in until you click one, and the dialog never changes size. Picking it fills the manufacturer, the **part number as the order code only** (e.g. `BX80524R300128`; the **S-Spec**, the short code printed on the chip such as `SL32A`, is saved as its own spec), the CPU category (even if another was selected) and a proper model name built from the record (e.g. "Celeron 300MHz 128KiB L2"), replacing a model field that only held the code you typed (but never a name you wrote yourself). The match is saved with the item as confirmed and **its specs are copied onto the item itself** (Speed, Bus speed, L2 cache, Package, Family, source link…, listed under *Specifications*): they belong to the item, are editable, show up as a one-line summary under the name in the inventory, are searchable (try `sepp` or `66mhz`) and travel in the CSV export/import (`specs` column). What you typed always wins, and unlinking keeps the specs. The link only remembers where they came from; the original dataset record is under a collapsed *The original record in the dataset* on the item page. Edit any field you like, or press ✕ on the green line to drop the match. The dataset names chips only by family and speed, so the cache is added to tell a plain "Celeron 300" (no cache) from a "300A" (128 KiB); marketing names are not invented.

**For existing items:** on an item page, **Find reference match** suggests models by part number (including codes such as an S-Spec) and name; you choose **Confirm match** or **Mark as candidate**, and once matched, **Use this name** renames an item that was added as just a code and **Fill in missing specs** copies any specs the item does not have yet (never overwriting yours).

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

The scale tests in `backend/tests/test_scale.py` seed 100,000 items and check query plans and latency. The browser tests include an automated accessibility audit (axe-core, WCAG A/AA) of every screen. `.github/workflows/ci.yml` runs all of this on GitHub.

### Layout

```
backend/    FastAPI app (app/), Alembic migrations (alembic/), tests (tests/)
frontend/   Next.js app (src/), API proxy at src/app/api/v1/[...path]/route.ts
e2e/        Playwright smoke tests
```

## API

Interactive docs: `/api/v1/docs` (through the frontend; the viewer page loads its scripts from a CDN, so it needs internet, while `/api/v1/openapi.json` always works offline). Lists use cursor (keyset) pagination: pass the returned `next_cursor` back as `cursor`. Search and filtering run in SQL (PostgreSQL `pg_trgm` indexes).
