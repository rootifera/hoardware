"""Management commands: ``python -m app.cli <command>``."""

import argparse
import json
import logging
import sys
import time
from pathlib import Path

from sqlalchemy import select

from app.backup import create_backup, list_backups, restore_backup
from app.config import get_settings
from app.db import SessionLocal
from app.models import Photo
from app.reference.registry import ADAPTERS
from app.reference.runner import ImportReport, run_import
from app.services.photos import process_pending_deletions
from app.storage import ObjectNotFound, StorageError, build_storage, get_storage

log = logging.getLogger("hoardware.cli")


def cmd_backup(_: argparse.Namespace) -> int:
    for info in create_backup():
        print(f"{info.where}: {info.name} ({info.size} bytes)")
    return 0


def cmd_backup_loop(_: argparse.Namespace) -> int:
    interval = get_settings().backup_interval_hours * 3600
    while True:
        try:
            for info in create_backup():
                log.info("backup written to %s: %s (%d bytes)", info.where, info.name, info.size)
        except Exception:
            log.exception("backup failed")
        time.sleep(interval)


def cmd_list_backups(_: argparse.Namespace) -> int:
    for info in list_backups():
        print(f"{info.where:5}  {info.name}  {info.size:>12} bytes  {info.modified:%Y-%m-%d %H:%M:%S}")
    return 0


def cmd_restore(args: argparse.Namespace) -> int:
    restore_backup(args.name, args.source)
    print(f"restored {args.name}")
    return 0


def cmd_storage_gc(_: argparse.Namespace) -> int:
    with SessionLocal() as session:
        deleted, failed = process_pending_deletions(session, get_storage(), limit=100_000)
    print(f"deleted {deleted} queued object(s); {failed} still failing")
    return 1 if failed else 0


def cmd_migrate_photos(args: argparse.Namespace) -> int:
    if args.source == args.target:
        print("source and target must differ", file=sys.stderr)
        return 2
    source, target = build_storage(args.source), build_storage(args.target)
    copied = skipped = failed = 0
    with SessionLocal() as session:
        photos = session.execute(select(Photo.id, Photo.storage_key, Photo.thumb_key)).yield_per(500)
        for photo_id, *keys in photos:
            for key in keys:
                try:
                    if target.exists(key):
                        skipped += 1
                    else:
                        chunks, size = source.open(key)
                        data = b"".join(chunks)
                        target.put(key, data, "application/octet-stream")
                        if len(data) != size:
                            raise StorageError(f"size mismatch for {key}")
                        copied += 1
                    if args.delete_source:
                        source.delete(key)
                except (StorageError, ObjectNotFound) as exc:
                    failed += 1
                    print(f"photo {photo_id}: {key}: {exc}", file=sys.stderr)
    print(f"copied {copied}, already present {skipped}, failed {failed}")
    if not failed:
        print(f"Now set STORAGE_BACKEND={args.target} and restart the backend.")
    return 1 if failed else 0


def cmd_import_reference(args: argparse.Namespace) -> int:
    adapter = ADAPTERS[args.source]()
    path = Path(args.path)
    if not path.exists():
        print(f"error: {path} does not exist", file=sys.stderr)
        return 1

    def progress(report: ImportReport) -> None:
        print(f"  ... added {report.added}, changed {report.changed}, unchanged {report.unchanged}", flush=True)

    with SessionLocal() as session:
        report = run_import(session, adapter, path, dry_run=args.dry_run, progress=progress)
    print(("DRY RUN (nothing saved): " if report.dry_run else "") + json.dumps(report.summary(), indent=2))
    for issue in report.issues[: args.show_issues]:
        print(f"  [{issue['level']}] {issue['where']}: {issue['message']}")
    hidden = len(report.issues) - args.show_issues
    if hidden > 0:
        print(f"  ... {hidden} more issue(s) are stored with the import record")
    return 1 if report.errors and not report.added + report.changed + report.unchanged else 0


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("backup", help="dump the database to the configured destinations").set_defaults(func=cmd_backup)
    sub.add_parser("backup-loop", help="run backups on BACKUP_INTERVAL_HOURS").set_defaults(func=cmd_backup_loop)
    sub.add_parser("list-backups", help="list available backups").set_defaults(func=cmd_list_backups)

    restore = sub.add_parser("restore", help="restore a backup, replacing the current database contents")
    restore.add_argument("name", help="backup file name, e.g. hoardware-20261013T120000Z.dump")
    restore.add_argument("--source", choices=["local", "s3"], help="where to read it from (default: local if present)")
    restore.set_defaults(func=cmd_restore)

    sub.add_parser("storage-gc", help="retry deleting stored objects queued for removal").set_defaults(func=cmd_storage_gc)

    migrate = sub.add_parser("migrate-photos", help="copy all photos from one storage backend to another")
    migrate.add_argument("--from", dest="source", choices=["local", "s3"], required=True)
    migrate.add_argument("--to", dest="target", choices=["local", "s3"], required=True)
    migrate.add_argument("--delete-source", action="store_true", help="remove each object from the source after copying")
    migrate.set_defaults(func=cmd_migrate_photos)

    imp = sub.add_parser("import-reference", help="import a reference hardware dataset from local files")
    imp.add_argument("source", choices=sorted(ADAPTERS))
    imp.add_argument("path", help="file or directory containing the dataset (inside the container)")
    imp.add_argument("--dry-run", action="store_true", help="parse and report, but save nothing")
    imp.add_argument("--show-issues", type=int, default=20, help="how many errors/skips to print")
    imp.set_defaults(func=cmd_import_reference)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (StorageError, RuntimeError, ValueError, FileNotFoundError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
