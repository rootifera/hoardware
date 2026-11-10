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

On a server, `./deploy.sh` does everything: it pulls the latest code, builds the containers, creates `.env` if there is none, starts the application, and downloads and imports the CPU and GPU reference data.

The first time it asks for the timezone, the port, the sign-in username and password (stored only as a hash), where to keep photos and downloads (a local volume, or S3 with an optional folder, checked before it carries on), whether to take daily backups and where to copy them (local volume only, the same S3 bucket, or a **different** S3 bucket or service, which is the safest), and whether to fetch the reference data. The database password is generated. An existing `.env` is never touched.

| Command | |
| --- | --- |
| `./deploy.sh` | update and restart; the reference data is refreshed when it changed upstream |
| `./deploy.sh --no-cache` | rebuild the images from scratch |
| `./deploy.sh --reset-password` | choose a new sign-in password (and username); signs everyone out |
| `./deploy.sh --no-data` | skip the reference data step (no internet, or you manage it yourself) |

The reference data (CPU-DB and GPUs-Specs, git-cloned into `./reference-data/`) is imported when it is new, has changed, or is missing from the database; set `REFERENCE_DATA=no` in `.env` to turn the step off for good. A problem with it never stops the deploy.

By hand:

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
| `n` | Quick add (Enter = Save)                          |
| `Ctrl/⌘ + S` | Save on the item page                    |

## Using it

- **Inventory**: instant search across code, manufacturer, model, part number, chipset and notes; filter by category, manufacturer, condition, test status, identification and location (with or without sub-locations); sort by latest, name, category or location. Filters live in the URL, so a search can be bookmarked.
- **Category-specific item pages**: each category defines its own fields, so a CPU is described as a CPU (Family, Speed, Bus speed, L2 cache, Socket, Package, Stepping…) and a graphics card as a graphics card (Chipset maker, Chipset, Memory size, Bus…); chipset fields only appear where they make sense. The item page is a stack of clear sections: Overview, *Specifications* for its category, Condition & testing, Where it is, test history, with photos beside them and the secondary actions (add another like this, delete) in the **⋯** menu. Fields can offer **predefined values** (RAM type, capacity, speed, ECC; storage interface, capacity, RPM; sockets, buses and so on come with sensible lists): click the field to pick one, type to narrow the list, or ignore it and type any value of your own. Edit the lists per field under *Predefined values* in the field editor. Change a category's fields on the **Categories** page (*Fields*): add, rename, reorder, remove. The seven default categories start with sensible fields. Values you enter are the item's own specs (searchable, shown on the inventory row, in the CSV `specs` column); anything not covered by the category's fields appears under *Other specs*.
- **Quick add**: only a category and a description are required. Category and location are remembered between additions, and as you type it tells you if you already have matching items.
- **Status strip**: above the list, chips show how many items are Untested, Unknown, POST, Full Test or Dead (respecting your other filters); click one to filter.
- **Test history**: every change of an item's test status is logged automatically with the date and the notes in force at the time, and you can log a test by hand (result, date, what was tested). The item page shows the history and when it was last tested. Items created by CSV import start with no history.
- **Test status vs condition**: independent. `Unknown` means testing is currently impossible (note why in *Test notes*); `Untested` means not tried yet.
- **Downloads**: each item has a *Downloads* section for manuals, drivers, firmware/BIOS, tools and datasheets. Drop files on it (up to `MAX_FILE_BYTES`, 1 GB by default); each file gets a kind (guessed from the extension, changeable), a description (version, OS…) and a download link. Files are always sent as attachments, never opened in the browser, and are stored (and streamed) via the same photo storage, S3 when configured.
- **Every physical item is its own record** with its own code (`HW-000001`, never reused), so identical parts can differ in location, condition and test result.
- **Locations**: a tree (`Workshop > Shelf 2 > CPU Box 3`); moving or renaming a location updates everything inside it.
- **Exact location = location + position**: create a location, then locations inside it (each can have a free-text type: shelf, box, drawer…). An item's *Position* is its exact spot inside its location, and two items can't share one. Quick add with **Add several separate items…** set to 10 and **Position** = 1 puts ten identical CPUs, as ten separate items, at positions 1–10; *Save & add another* carries on from 11. Sibling locations may share a name.
- **Stock-take**: each item records when it was last *verified* (seen in place). Tick what is physically there and press **Verified** in the bulk bar, then use the *Last verified* filter (or the *Stock-take* filter on a location's page) to list what has not been seen in 30/90/365 days, or never. **Print list** on a location's page gives a printable, position-ordered sheet with a tick box per item, grouped by sub-location, for checking on paper.
- **Bulk actions**: tick rows (shift-click selects a range, or *Select all N matching* for everything the filters match) and a bar appears above the list and stays in view while you scroll: set the test status, condition, category or test notes, mark **Verified**, **Move…** to a location, **Export** the selected items as a CSV, or **Delete…** them (with their photos and files; a large deletion has to be confirmed by typing *delete*). When moving you choose what happens to positions: clear them, number on after the last one in the destination, or keep them (refused if any would clash, with a count shown before you commit). On a location's page, **Move all items…** moves everything out of it.
- **CSV export and import**: the **CSV** button exports the current filter (streamed, so it works at any size). **Import** takes a CSV (the export's columns, a template is provided, and friendly header names such as `name`, `p/n` work too), checks every row first and shows the problems by line, and writes nothing until you confirm. It is all-or-nothing unless you tick *Skip rows with errors*; *Create missing categories/locations* fill in what the file refers to. Every row becomes a new item with a new code.

## Where things are, and where they have been

- **Status.** Every item is *In collection*, *Installed in a build*, *Lent out*, *Sold*, *Scrapped* or on your *Wishlist*. Change it in **Where it is now** on the item page (with a note: who has it, who bought it), in bulk (**Status…**), or add something you are looking for with **On my wishlist** in Quick add. The inventory lists **what you own** by default (collection, builds, lent out); the *Item status* filter shows sold, scrapped, wishlist or everything. Sold, scrapped and wishlist items leave their shelf (their position is free again) but keep their record and history. In the CSV, the column is `item_status`.
- **Builds.** Choose what a part is **Installed in** (a PC, a case, a board) and the build's page lists its parts. A part can be installed in one thing at a time; deleting the build returns its parts to the collection.
- **History.** Every move between locations and every status or build change is logged with the date, readable even after a location is deleted. It is shown under *Where it is now*.
- **Price and source.** *Price paid* and *Bought from* sit with the acquisition date (the CSV has `price` and `source`).
- **Stock in several places.** A stock item can be split: **Some of these are somewhere else…** moves a quantity to another location as its own record, each with its own code, so every drawer shows its own count.
- **Filter and sort by a spec.** The *Filter by spec…* control in the filter bar picks one of the specs in use and a condition (*is*, *at least*, *at most*); numbers understand units, so *Speed at least 100MHz* matches 133 MHz and 1.2 GHz, and *Cache at least 1MB* matches 1 MiB. The sort menu gains *<spec> value*. Items without that spec go last. In the bulk bar, **Spec…** sets (or removes) one spec on every selected item, for example Socket = Socket 7 on forty CPUs.

## Barcode labels and scanning

Every item has its own unique code (`HW-000123`, or your own prefix), and that code is the barcode unless you give the item one of its own:

- **Original barcode (optional).** If an item came with a barcode (the EAN/UPC on the packaging) enter it as **Barcode** ("Add barcode" in Quick add, or on the item page; it also goes in the CSV as `barcode`, `ean` or `upc`). Without one, labels and scans use the item's own code. Several items may share a barcode (identical boxed parts).
- **Print labels:** **Print label** in an item's ⋯ menu, or **Labels** in the bulk bar for everything you have selected (or "Select all N matching", up to 1,000 at a time). Each label has a Code 128 barcode (any scanner reads it) of the item's original barcode, or of its own code if it has none, with the text and the item's name. Choose an A4 label sheet (3 across, 63.5 × 38.1 mm) or a label printer size (62 × 29, 50 × 25, 89 × 36 mm) and press Print. Use 100% / "Actual size" and turn off headers and footers in the print dialog.
- **Location labels:** a box, shelf or drawer gets a label too (**Label** on its page on the Locations screen): scan it and its contents open. Location codes look like `LOC-000012`.
- **Phone camera:** the camera button in the top bar (and next to the barcode fields) reads a barcode with the phone's camera. It needs the page to be served over https (or from localhost), which the browser insists on for any camera use. Chrome on Android reads barcodes itself; other browsers use a small decoder bundled with the app (no external download, no data leaves your server).
- **Scan to find:** with a USB scanner (they type the code and press Enter), scan anywhere in the app and the item opens: in the search box, or on any page where no text field has focus. If several items carry the scanned barcode, the list of them is shown instead. Typing a code into the search box and pressing Enter does the same. A scan is recognised by its speed, so a person typing slowly is not mistaken for one, and a scanner's letters never trigger the one-key shortcuts (`n`, `/`, `?`).
- With **Track as stock**, scan a bin, then **Take out** on the item page.

## Standard or your own collection

Hoardware is built for PC hardware, but nothing forces you to keep PC hardware. The first time you sign in to an empty install it asks:

- **PC hardware (standard):** the CPU, GPU, motherboard, sound card, RAM and storage categories with ready-made fields and predefined values, and the CPU and graphics lookups.
- **Something else (customise):** pick a starter set, name your collection and choose the item code prefix (`MG-000001`, `TC-000001`…). The sets are **Music gear**, **Trading cards & collectibles**, **Electronics & components** and **Start empty** (one empty category to build on). The choice only decides where you start: everything stays editable.

A custom setup replaces the standard categories, so it is only offered while there are no items. You can add any starter set later from **Categories → Add a starter set…** (including the PC one); that only adds categories you do not have yet. Installs that already have items count as set up and are not asked.

**Customising a category.** On the Categories page, *Fields* has two tabs. *Specifications* is the category's own fields with their predefined values. *Standard details* decides which of the standard fields the category shows and what they are called: hide the manufacturer, part number, condition, test status, notes or dates where they make no sense (a trading card is not "tested"), rename them ("Brand", "Card number", "Works?"), and show condition and test-status values under other names ("Near mint", "Powers on"). Quick add, the item page, the inventory list and its filters all follow. Hiding only removes a field from the screens: anything already entered is kept, and the stored values never change.

**Track as stock.** Some things you count instead of listing one by one: capacitors, screws, blank CDs, cables. Tick **Track as stock** (in Quick add, or on the item page) and the item becomes one record with a quantity: "1000 × 10 µF". A stock item gets:

- a **Stock** panel on its page: type how many and press **Take out** (1000 becomes 990) or **Add**, optionally with what it was for; it cannot go below zero, and two people taking at the same moment can never take the same piece;
- a **history** of every change (what, how many, when, what for, what was left), including quantities you set by hand after a recount;
- an optional **Warn me at** level: at or under it the list shows **Low** (and **Out** at zero), the panel warns, and the **Low stock** filter lists everything that needs restocking;
- a "×990" tag in the list and on the item page, and a `quantity` column in the CSV export and import (`qty` works too; a row with a quantity becomes a stock item).

Whether the box starts ticked is a per-category default (*Standard details → Start new items as stock items*): the electronics components and tools, music cables, trading-card-game and sealed-product starter categories start ticked, PC categories do not, and you can untick it for a one-off item such as an oscilloscope. Where an item is not stock, Quick add still offers **Add several separate items…** for things like ten identical CPUs, each getting its own code and position. Setting a stock quantity to 0 keeps the record.

Starter sets are plain JSON files in `backend/app/presets/`, so adding one for another hobby means adding a file.

## Versions and updates

`version.json` in the repository root is the single source of truth for the version:

```json
{ "app_name": "Hoardware", "version": "1.0.0", "build_name": "Malachite", "build_time": 1790617897 }
```

The installed version is baked into the backend image from this file and shown in small type in the bottom-left corner of every page (hover for the build date). The app also fetches `version.json` from the git repository every 6 hours; when the published version is higher (or the same version with a later `build_time`) the corner text becomes a small amber **"1.1.0 available"** pill that explains how to update (`./deploy.sh`). A failed check never gets in the way: the installed version is still shown, and the log says why it failed.

To publish a release: edit `version.json` (new `version`, a `build_name`, and `build_time` = `date +%s`), commit and push. Installs notice within about six hours.

`VERSION_CHECK_URL` defaults to this repository's `main` branch (`deploy.sh` sets it from your checkout when it creates `.env`); set it to `off` to switch the check off. If you run a **private fork**, GitHub answers 404 to an anonymous request: put a fine-grained read-only token (*Contents: read-only*, that repository only) in `.env` as `VERSION_CHECK_TOKEN`.

## Login and running behind a reverse proxy

Hoardware has a single-user login. Set a password in `.env` and it is required for everything (the pages, the API, photos and downloads); without one the app is open, and the backend logs a warning at start.

```bash
docker compose run --rm --no-deps backend python -m app.cli hash-password   # prints AUTH_PASSWORD_HASH=...
# put that line (and AUTH_USERNAME, default "admin") in .env, then: docker compose up -d
```

`AUTH_PASSWORD` (plain text) also works if you prefer. The session is a signed, HttpOnly, SameSite=Lax cookie valid for `AUTH_SESSION_DAYS` (30); changing the password signs everyone out. Eight wrong attempts in ten minutes lock sign-in for a while. The interactive API docs are switched off while login is on. `/api/v1/health` stays open for health checks.

**TLS and the proxy** are yours to provide (for example BunkerWeb). Point it at the frontend service (`http://frontend:3000` on the same Docker network, or `http://<host>:3100` via `FRONTEND_PORT`) and never at the backend, which is not published. The cookie is marked `Secure` when the proxy sends `X-Forwarded-Proto: https` (most do). Check these on the proxy:

- the upload limit: photos are up to `MAX_UPLOAD_BYTES` (20 MB) and downloads up to `MAX_FILE_BYTES` (1 GB), so the proxy's maximum request body (BunkerWeb: `MAX_CLIENT_SIZE`) has to allow that, or large files fail with a 413 before reaching the app;
- websockets are not used, and no special timeouts are needed beyond the usual for large uploads;
- set a real `POSTGRES_PASSWORD` in `.env` before the first start (the database is only reachable inside the Compose network, but there is no reason to keep the default).

## Photo and file storage

Photos and downloads (manuals, drivers, tools…) are stored outside the database, in the same place. `STORAGE_BACKEND` chooses it:

- `auto` (default): S3 if `S3_BUCKET` is set, otherwise the local volume. Configure S3 and everything goes there, nothing else to switch.
- `local`: always the `photos` Docker volume.
- `s3`: any S3-compatible service (AWS S3, RustFS, MinIO, Backblaze B2, Cloudflare R2…).

```env
STORAGE_BACKEND=s3
S3_ENDPOINT_URL=http://your-s3-host:9000   # empty for AWS S3
S3_REGION=us-east-1
S3_BUCKET=hoardware                        # must already exist
S3_PREFIX=                                 # empty = bucket root
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=true                   # true for most self-hosted services
```

Objects are stored as `<S3_PREFIX>items/<item id>/photos/<uuid>.jpg` (plus `_thumb.webp`) and `<S3_PREFIX>items/<item id>/files/<id>/<original file name>`, so the bucket is readable when browsed directly. The bucket stays private: the backend streams everything itself. If the S3 service runs outside this Compose project, the `backend` container must be able to reach `S3_ENDPOINT_URL` (use the host's LAN address, or `host.docker.internal`).

The database stores only backend-independent keys. When S3 is configured after photos or files were already saved locally, copy them across (photos and downloads both):

```bash
docker compose run --rm --no-deps backend python -m app.cli migrate-photos --from local --to s3
# then configure S3 (STORAGE_BACKEND=auto picks it up) and: docker compose up -d
```

Objects saved under an older layout (or the former default prefix `photos/`) are moved with `docker compose run --rm --no-deps backend python -m app.cli relayout-storage --from-prefix photos/` (leave out `--from-prefix` for local storage).

Add `--delete-source` to remove each object from the old backend after it has been copied. If an object cannot be deleted when a photo or item is removed (storage outage), it is queued and retried with `python -m app.cli storage-gc`.

## Backups and restore

CSV export is **not** a backup. A full backup is **the database plus the photos**, and the two should be restored together.

### Database

```bash
docker compose run --rm --no-deps backend python -m app.cli backup         # pg_dump to the "backups" volume
docker compose run --rm --no-deps backend python -m app.cli list-backups
```

Set `BACKUP_S3_BUCKET` (and optionally `BACKUP_S3_PREFIX`, `BACKUP_S3_ENDPOINT_URL`, `BACKUP_S3_REGION`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`; unset ones fall back to `S3_*`) and every backup is also uploaded to S3. The newest `BACKUP_RETENTION_COUNT` (default 14) are kept on each destination.

**Knowing when backups stop.** With scheduled backups on (`deploy.sh` sets `BACKUP_EXPECTED=yes`), the app watches them: if the newest backup is older than two intervals or the last attempt failed, an amber warning appears at the top of every page, and `/api/v1/health` reports `backups: stale | failing | none` (without failing the health check). Set `BACKUP_NOTIFY_URL` to also get a message when a backup fails and when it works again: a Slack, Discord, Mattermost or Gotify webhook, or an ntfy topic URL (`BACKUP_NOTIFY_FORMAT` picks JSON or plain text, `auto` by default).

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

### Sound, network and other PCI cards

The PCI ID Repository (<https://github.com/pciutils/pciids>) names every PCI chip by its `vendor:device` pair (`1102:0002` is Creative's EMU10k1, the chip of the Sound Blaster Live!). `./deploy.sh` fetches it; by hand: clone it into `./reference-data/pci-ids/` and run `docker compose run --rm --no-deps backend python -m app.cli import-reference pci-ids /reference-data/pci-ids`. In categories whose name says sound, audio, network, LAN, SCSI, RAID, USB, modem, capture or controller, Quick add's lookup box then finds the chip by its ID (as printed by `lspci -nn`) or name and adds the PCI ID to the item's specs. The card's own maker and model are never touched. ISA and other old cards have no IDs, so they are filled in by hand.

### Graphics cards

The GPUs-Specs dataset (<https://github.com/RonnyMuthomi/GPUs-Specs>, a TechPowerUp-derived CSV; 3,200 chips and reference cards from 1986 on) is supported the same way: clone it (or just `gpu_*.csv`) into `./reference-data/gpus-specs/` and run

```bash
docker compose run --rm --no-deps backend python -m app.cli import-reference gpus-specs /reference-data/gpus-specs
```

A graphics card is two things: the **card** (maker + model, e.g. *Diamond Viper V770 Ultra*, which no dataset knows) and its **chip** (*RIVA TNT2 Ultra*, which the dataset does). Quick add has a **Chipset** field for the chip: type `tnt2 ultra`, `voodoo3 3000` or `rage pro` there and pick the suggestion. The card's manufacturer, model and part number are never touched; the chipset maker, chipset and the chip's specs (GPU chip, memory size, type and bus width, bus, clocks, release date…) are saved onto the item, so one item holds both. The inventory row shows the chip summary under the card's name. Your own values always win over the dataset's. On an existing card, **Find reference match** looks up its *Chipset* field.

**While adding a CPU:** open Quick add and type the code printed on the chip (an S-Spec such as `SL32A`, or an ordering code) into *Part number* or *Model*, or a name in a CPU category. A dropdown floats under the field with matching records, each showing a readable name, the full part number and the key specs (speed, bus, cache, package); nothing is filled in until you click one, and the dialog never changes size. Picking it fills the manufacturer, the **part number as the order code only** (e.g. `BX80524R300128`; the **S-Spec**, the short code printed on the chip such as `SL32A`, is saved as its own spec), the CPU category (even if another was selected) and a proper model name built from the record (e.g. "Celeron 300MHz 128KiB L2"), replacing a model field that only held the code you typed (but never a name you wrote yourself). The match is saved with the item as a **candidate** (you confirm it on the item page once you have checked it) and **its specs are copied onto the item itself** (Speed, Bus speed, L2 cache, Package, Family, source link…, listed under *Specifications*): they belong to the item, are editable, show up as a one-line summary under the name in the inventory, are searchable (try `sepp` or `66mhz`) and travel in the CSV export/import (`specs` column). What you typed always wins, and unlinking keeps the specs. The link only remembers where they came from; the original dataset record is under a collapsed *The original record in the dataset* on the item page. Edit any field you like, or press ✕ on the green line to drop the match. The dataset names chips only by family and speed, so the cache is added to tell a plain "Celeron 300" (no cache) from a "300A" (128 KiB); marketing names are not invented.

**For existing items:** on an item page, **Find reference match** suggests models by part number (including codes such as an S-Spec) and name; you choose **Confirm match** or **Mark as candidate**, and once matched, **Use this name** renames an item that was added as just a code and **Fill in missing specs** copies any specs the item does not have yet (never overwriting yours).

## Development

```bash
# backend tests (real PostgreSQL; creates a throwaway <db>_test database next to the app's)
docker compose up -d db
docker compose run --rm --no-deps backend pytest

# frontend
cd frontend && npm install && npm run lint && npx tsc --noEmit

# browser smoke tests against the running stack (Playwright in a container). They expect the standard PC
# categories: run them against a fresh install (their setup step picks "standard" on an empty one), not one
# you have customised.
cd e2e && npm install
docker run --rm --network hoardware_default -v "$PWD":/work -w /work \
  -e BASE_URL=http://frontend:3000 mcr.microsoft.com/playwright:v1.64.0-noble npx playwright test
```

The browser tests run in Chromium, Firefox, WebKit (Safari's engine) and a phone-sized touch device (`--project=chromium|firefox|webkit|phone`). Set `E2E_PASSWORD` (and `E2E_USER`) when the stack has login switched on. CI also audits the dependencies for known vulnerabilities (`npm audit`, `pip-audit`; weekly as well as on every push), lints `deploy.sh` with shellcheck, and runs it end to end.

The scale tests in `backend/tests/test_scale.py` seed 100,000 items and check query plans and latency. The browser tests include an automated accessibility audit (axe-core, WCAG A/AA) of every screen. `.github/workflows/ci.yml` runs all of this on GitHub.

### Layout

```
backend/    FastAPI app (app/), Alembic migrations (alembic/), tests (tests/)
frontend/   Next.js app (src/), API proxy at src/app/api/v1/[...path]/route.ts
e2e/        Playwright smoke tests
```

## API

Interactive docs: `/api/v1/docs` (through the frontend; the viewer page loads its scripts from a CDN, so it needs internet, while `/api/v1/openapi.json` always works offline). Lists use cursor (keyset) pagination: pass the returned `next_cursor` back as `cursor`. Search and filtering run in SQL (PostgreSQL `pg_trgm` indexes).
