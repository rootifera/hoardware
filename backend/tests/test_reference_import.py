from sqlalchemy import select

from app.models import Item, ReferenceImport, ReferenceModel, ReferenceSource
from app.reference.base import build_keys, match_key, token_keys_of
from app.reference.cpudb import CpuDbAdapter
from app.reference.runner import run_import
from tests.cpudb_data import row, write_vendor


def read(directory):
    return list(CpuDbAdapter().read(directory))


def records(directory):
    return [r for r in read(directory) if hasattr(r, "upstream_id")]


def issues(directory):
    return [r for r in read(directory) if not hasattr(r, "upstream_id")]


def test_header_with_repeated_empty_columns_is_parsed_positionally(tmp_path):
    write_vendor(
        tmp_path,
        "Acme",
        [row("Acme", "Widget", "W100", {"Socket": "Socket 7", "Frequency(internal max/typ)": "200MHz", "Chip Type": "CPU"})],
    )
    (record,) = records(tmp_path)
    assert record.manufacturer == "Acme" and record.family == "Widget" and record.model == "W100"
    assert record.specs == {"Socket": "Socket 7", "Frequency(internal max/typ)": "200MHz", "Chip Type": "CPU"}
    assert record.provenance == {"file": "cpu-db.Acme.csv", "line": 2}
    assert record.upstream_id == "acme|widget|w100"


def test_short_rows_are_padded_values_trimmed_and_placeholders_handled(tmp_path):
    write_vendor(
        tmp_path,
        "Acme",
        [row("Acme", "Widget", "W100", {"Socket": "  Socket 7  ", "L2 cache": "NA", "Package": "none", "CPUID": ""}, short=True)],
    )
    (record,) = records(tmp_path)
    assert record.specs["Socket"] == "Socket 7"
    assert record.specs["L2 cache"] is None  # not applicable
    assert record.specs["Package"] == "none"  # a real value, e.g. "has no package"
    assert "CPUID" not in record.specs  # blank = unknown, omitted


def test_aliases_stepping_references_and_skipped_columns(tmp_path):
    write_vendor(
        tmp_path,
        "Acme",
        [
            row(
                "Acme", "Widget", "W100 Q123",
                {
                    "Alternative Label 1": "W100", "Alternative Label 2": "W100 Q123",  # same as part: dropped
                    "Core Stepping": "B1", "Reference 1": "http://example.test/a", "Reference 2": "Datasheet X",
                    "Photo front filename 1": "front.jpg", "Photo front creator 1": "someone",
                },
            )
        ],
    )
    (record,) = records(tmp_path)
    assert record.aliases == ["W100"]
    assert record.revision == "B1"
    assert record.specs["references"] == ["http://example.test/a", "Datasheet X"]
    assert not any(k.startswith("Photo") or k == "Empty" for k in record.specs)
    assert "Alternative Label 1" not in record.specs


def test_exact_duplicates_collapse_and_differing_rows_become_variants(tmp_path):
    same = row("Acme", "Widget", "W100", {"Socket": "S7"})
    write_vendor(
        tmp_path,
        "Acme",
        [same, same, row("Acme", "Widget", "W100", {"Socket": "S8"}), row("Acme", "Other", "W100")],
    )
    write_vendor(tmp_path, "Zed", [row("Acme", "Widget", "W100", {"Socket": "S7"})])  # also an exact duplicate
    recs = records(tmp_path)
    assert sorted(r.upstream_id for r in recs) == ["acme|other|w100", "acme|widget|w100", "acme|widget|w100#2"]
    skipped = [i for i in issues(tmp_path) if i.level == "skipped"]
    assert len(skipped) == 2


def test_rows_without_a_part_number_are_reported_with_location(tmp_path):
    write_vendor(tmp_path, "Acme", [row("Acme", "Widget", ""), row("Acme", "Widget", "W2"), ["", "", ""]])
    assert [r.model for r in records(tmp_path)] == ["W2"]
    errors = issues(tmp_path)
    assert [(i.level, i.where) for i in errors] == [("error", "cpu-db.Acme.csv:2")]


def test_blank_manufacturer_is_taken_from_the_vendor_file_name(tmp_path):
    write_vendor(tmp_path, "Chips_and_Technology", [row("", "Widget", "W1")])
    (record,) = records(tmp_path)
    assert record.manufacturer == "Chips and Technology"
    assert record.provenance["manufacturer_inferred_from_filename"] is True


def test_combined_and_debug_files_are_ignored_and_empty_dirs_reported(tmp_path):
    write_vendor(tmp_path, "Acme", [row("Acme", "Widget", "W1")])
    write_vendor(tmp_path, "DEBUGTEST", [row("Debug", "x", "D1")])
    (tmp_path / "cpu-db.csv").write_text("combined,lossy\n")
    assert [r.model for r in records(tmp_path)] == ["W1"]
    empty = tmp_path / "empty"
    empty.mkdir()
    (issue,) = issues(empty)
    assert issue.level == "error" and "no cpu-db" in issue.message


def test_header_missing_required_columns_is_an_error(tmp_path):
    write_vendor(tmp_path, "Acme", [["x", "y"]], header=["Foo", "Bar"])
    (issue,) = issues(tmp_path)
    assert issue.level == "error" and "Manufacturer" in issue.message


def test_key_helpers():
    assert match_key("A80501-60 Q0352") == "a8050160q0352"
    assert token_keys_of("A80501-60 Q0352") == {"a8050160", "q0352"}
    assert token_keys_of("BP80521180 256K SL23L") == {"bp80521180", "256k", "sl23l"}
    exact, tokens = build_keys("A80503150 Q0939", ["A80503150"])
    assert exact == ["a80503150", "a80503150q0939"] and tokens == ["q0939"]


# --- runner -----------------------------------------------------------------


def three_rows():
    return [
        row("Acme", "Widget", "W100", {"Socket": "S7"}),
        row("Acme", "Widget", "W200 Q1", {"Socket": "S8"}),
        row("Acme", "Gadget", "G1"),
    ]


def test_import_is_idempotent(tmp_path, db):
    write_vendor(tmp_path, "Acme", three_rows())
    first = run_import(db, CpuDbAdapter(), tmp_path)
    assert (first.added, first.changed, first.unchanged, first.errors) == (3, 0, 0, 0)
    ids = {r.upstream_id: r.id for r in db.scalars(select(ReferenceModel))}

    again = run_import(db, CpuDbAdapter(), tmp_path)
    assert (again.added, again.changed, again.unchanged) == (0, 0, 3)
    assert {r.upstream_id: r.id for r in db.scalars(select(ReferenceModel))} == ids
    assert db.query(ReferenceImport).count() == 2
    source = db.get(ReferenceSource, "cpu-db")
    assert source.name == "CPU-DB" and source.licence


def test_changed_rows_are_updated_in_place_and_links_survive(tmp_path, db, client, cats):
    write_vendor(tmp_path, "Acme", three_rows())
    run_import(db, CpuDbAdapter(), tmp_path)
    ref = db.scalar(select(ReferenceModel).where(ReferenceModel.upstream_id == "acme|widget|w100"))
    item = client.post("/api/v1/items", json={"category_id": cats["CPU"], "model": "mine", "attributes": {"Socket": "my override"}}).json()
    client.post(f"/api/v1/items/{item['id']}/reference-match", json={"reference_model_id": ref.id})

    rows = three_rows()
    rows[0] = row("Acme", "Widget", "W100", {"Socket": "S7 (corrected)"})
    write_vendor(tmp_path, "Acme", rows)
    report = run_import(db, CpuDbAdapter(), tmp_path)
    assert (report.added, report.changed, report.unchanged) == (0, 1, 2)

    db.expire_all()
    refreshed = db.get(ReferenceModel, ref.id)
    assert refreshed.specs["Socket"] == "S7 (corrected)"
    detail = client.get(f"/api/v1/items/{item['id']}").json()
    assert detail["reference_model_id"] == ref.id
    assert detail["reference"]["specs"]["Socket"] == "S7 (corrected)"
    assert detail["attributes"]["Socket"] == "my override"  # the user's value is untouched


def test_dry_run_saves_nothing(tmp_path, db):
    write_vendor(tmp_path, "Acme", three_rows())
    report = run_import(db, CpuDbAdapter(), tmp_path, dry_run=True)
    assert report.dry_run and report.added == 3
    assert db.query(ReferenceModel).count() == 0 and db.query(ReferenceImport).count() == 0


def test_records_missing_upstream_are_kept_and_counted(tmp_path, db):
    write_vendor(tmp_path, "Acme", three_rows())
    run_import(db, CpuDbAdapter(), tmp_path)
    write_vendor(tmp_path, "Acme", three_rows()[:2])
    report = run_import(db, CpuDbAdapter(), tmp_path)
    assert report.missing_upstream == 1 and report.unchanged == 2
    assert db.query(ReferenceModel).count() == 3


def test_report_counts_errors_and_skips_and_stores_issues(tmp_path, db):
    dup = row("Acme", "Widget", "W1")
    write_vendor(tmp_path, "Acme", [dup, dup, row("Acme", "x", ""), row("Acme", "Widget", "W2")])
    report = run_import(db, CpuDbAdapter(), tmp_path)
    assert (report.added, report.skipped, report.errors) == (2, 1, 1)
    run = db.scalars(select(ReferenceImport)).one()
    assert run.errors == 1 and run.skipped == 1 and len(run.report["issues"]) == 2


def test_batches_larger_than_one_flush(tmp_path, db):
    write_vendor(tmp_path, "Acme", [row("Acme", "Widget", f"P{i:04d}") for i in range(25)])
    report = run_import(db, CpuDbAdapter(), tmp_path, batch_size=10)
    assert report.added == 25
    report = run_import(db, CpuDbAdapter(), tmp_path, batch_size=10)
    assert report.unchanged == 25 and report.missing_upstream == 0
    assert db.query(Item).count() == 0


def test_errors_are_not_crowded_out_by_skipped_duplicates(tmp_path, db):
    dup = row("Acme", "Widget", "W1")
    rows = [dup] * 150 + [row("Acme", "Widget", "")]
    write_vendor(tmp_path, "Acme", rows)
    report = run_import(db, CpuDbAdapter(), tmp_path)
    assert report.skipped == 149 and report.errors == 1
    levels = [i["level"] for i in report.issues]
    assert levels.count("error") == 1 and levels.count("skipped") == 100
