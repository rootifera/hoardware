"""Idempotent, batched import of ReferenceRecords into the database."""

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import func, insert, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.models import ReferenceImport, ReferenceModel, ReferenceSource
from app.reference.base import (
    ParseIssue,
    ReferenceAdapter,
    ReferenceRecord,
    build_keys,
    build_search_text,
    build_sort_name,
)

log = logging.getLogger(__name__)

MAX_REPORTED_ERRORS = 1000  # errors are what the user must act on: keep (nearly) all
MAX_REPORTED_SKIPS = 100


@dataclass
class ImportReport:
    source_key: str
    source_version: str
    dry_run: bool = False
    added: int = 0
    changed: int = 0
    unchanged: int = 0
    skipped: int = 0
    errors: int = 0
    missing_upstream: int = 0  # in the database but absent from this run (kept)
    import_id: int | None = None
    issues: list[dict] = field(default_factory=list)

    def add_issue(self, issue: ParseIssue) -> None:
        if issue.level == "error":
            self.errors += 1
            keep = self.errors <= MAX_REPORTED_ERRORS
        else:
            self.skipped += 1
            keep = self.skipped <= MAX_REPORTED_SKIPS
        if keep:
            self.issues.append({"level": issue.level, "where": issue.where, "message": issue.message})

    def summary(self) -> dict:
        return {
            "source": self.source_key,
            "version": self.source_version,
            "dry_run": self.dry_run,
            "added": self.added,
            "changed": self.changed,
            "unchanged": self.unchanged,
            "skipped": self.skipped,
            "errors": self.errors,
            "missing_upstream": self.missing_upstream,
        }


def _row(record: ReferenceRecord, source_key: str, version: str, import_id: int, digest: str) -> dict:
    exact, tokens = build_keys(record.part_number, record.aliases)
    return {
        "source_key": source_key,
        "upstream_id": record.upstream_id,
        "kind": record.kind,
        "manufacturer": record.manufacturer,
        "family": record.family,
        "model": record.model,
        "part_number": record.part_number,
        "revision": record.revision,
        "aliases": record.aliases,
        "exact_keys": exact,
        "token_keys": tokens,
        "specs": record.specs,
        "provenance": record.provenance,
        "content_hash": digest,
        "source_version": version,
        "search_text": build_search_text(record),
        "sort_name": build_sort_name(record),
    }


def run_import(
    session: Session,
    adapter: ReferenceAdapter,
    path: Path,
    *,
    dry_run: bool = False,
    batch_size: int = 1000,
    progress: Callable[[ImportReport], None] | None = None,
) -> ImportReport:
    """Import a dataset. Existing records are matched on (source, upstream_id) and
    updated in place, so inventory links survive refreshes; records that vanish
    upstream are kept (and counted). A dry run rolls everything back."""
    version = adapter.source_version(path)
    report = ImportReport(adapter.source.key, version, dry_run)

    info = adapter.source
    session.execute(
        pg_insert(ReferenceSource)
        .values(key=info.key, name=info.name, url=info.url, licence=info.licence, attribution=info.attribution)
        .on_conflict_do_update(
            index_elements=["key"],
            set_={"name": info.name, "url": info.url, "licence": info.licence, "attribution": info.attribution},
        )
    )
    run = ReferenceImport(source_key=info.key, source_version=version, path=str(path))
    session.add(run)
    session.flush()
    report.import_id = run.id

    existing = {
        upstream_id: (row_id, digest)
        for upstream_id, row_id, digest in session.execute(
            select(ReferenceModel.upstream_id, ReferenceModel.id, ReferenceModel.content_hash).where(
                ReferenceModel.source_key == info.key
            )
        )
    }

    to_insert: list[dict] = []
    to_update: list[dict] = []
    unchanged_ids: list[int] = []

    def flush() -> None:
        if to_insert:
            session.execute(insert(ReferenceModel), [{**r, "import_id": run.id, "last_seen_import_id": run.id} for r in to_insert])
            to_insert.clear()
        if to_update:
            session.execute(
                update(ReferenceModel),
                [
                    {**r, "import_id": run.id, "last_seen_import_id": run.id, "imported_at": datetime.now(timezone.utc)}
                    for r in to_update
                ],
            )
            to_update.clear()
        if unchanged_ids:
            session.execute(
                update(ReferenceModel).where(ReferenceModel.id.in_(unchanged_ids)).values(last_seen_import_id=run.id)
            )
            unchanged_ids.clear()
        if progress:
            progress(report)

    for item in adapter.read(path):
        if isinstance(item, ParseIssue):
            report.add_issue(item)
            continue
        digest = item.content_hash()
        found = existing.get(item.upstream_id)
        if found is None:
            report.added += 1
            to_insert.append(_row(item, info.key, version, run.id, digest))
        elif found[1] != digest:
            report.changed += 1
            to_update.append({"id": found[0], **_row(item, info.key, version, run.id, digest)})
        else:
            report.unchanged += 1
            unchanged_ids.append(found[0])
        if len(to_insert) + len(to_update) + len(unchanged_ids) >= batch_size:
            flush()
    flush()

    report.missing_upstream = (
        session.scalar(
            select(func.count())
            .select_from(ReferenceModel)
            .where(ReferenceModel.source_key == info.key, ReferenceModel.last_seen_import_id != run.id)
        )
        or 0
    )

    run.finished_at = datetime.now(timezone.utc)
    run.added, run.changed, run.unchanged = report.added, report.changed, report.unchanged
    run.skipped, run.errors = report.skipped, report.errors
    run.report = {**report.summary(), "issues": report.issues}

    if dry_run:
        session.rollback()
    else:
        session.commit()
    return report
