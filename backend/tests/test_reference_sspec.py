import pytest
from sqlalchemy import select

from app.models import ReferenceModel
from app.reference.cpudb import CpuDbAdapter
from app.reference.runner import run_import
from tests.cpudb_data import row, write_sspecs, write_vendor

API = "/api/v1"


def records(directory):
    return {r.upstream_id: r for r in CpuDbAdapter().read(directory) if hasattr(r, "upstream_id")}


@pytest.fixture
def dataset(tmp_path):
    write_vendor(
        tmp_path,
        "Intel",
        [
            row("Intel", "Celeron", "BX80524R300128 SL32A", {"Frequency(internal max/typ)": "300MHz", "L2 cache": "128KiB", "Package": "SEPP Rev. 1"}),
            row("Intel", "Pentium", "A80502200 SY060", {"Frequency(internal max/typ)": "200MHz"}),
        ],
    )
    write_vendor(tmp_path, "AMD", [row("AMD", "K6", "AMD-K6-200ACR SL32A")])  # same code text, other maker
    write_sspecs(
        tmp_path,
        [
            {"Manufacturer": "Intel", "Family": "Celeron", "S-Spec number": "SL32A", "Speed": "300MHz", "Bus speed": "66MHz",
             "L2 cache size": "128KiB", "Package type": "SEPP Rev. 1", "Part number": "BX80524R300128", "Reference 1": "http://example.test/SL32A"},
            {"Manufacturer": "Intel", "Family": "Celeron", "S-Spec number": "SL27Z", "Speed": "300MHz", "Bus speed": "66MHz",
             "L2 cache size": "0KiB", "Package type": "SEPP", "Part number": "BX80523R300000", "Alternative part number 1": "BX80523R300"},
            {"Manufacturer": "Intel", "Family": "Pentium", "S-Spec number": "SY060", "Speed": "200MHz", "Bus speed": "66MHz", "L2 cache size": "256KiB"},
        ],
    )
    return tmp_path


def test_matching_main_records_gain_bus_speed_and_keep_their_own_values(dataset):
    recs = records(dataset)
    celeron = recs["intel|celeron|bx80524r300128 sl32a"]
    assert celeron.specs["Bus speed"] == "66MHz"
    assert celeron.specs["Frequency(internal max/typ)"] == "300MHz" and celeron.specs["L2 cache"] == "128KiB"
    assert "http://example.test/SL32A" in celeron.specs["references"]
    assert celeron.provenance["sspec_table"] is True
    pentium = recs["intel|pentium|a80502200 sy060"]
    assert pentium.specs["Bus speed"] == "66MHz"
    assert pentium.specs["L2 cache"] == "256KiB"  # the main row had none: filled from the table
    assert pentium.specs["Frequency(internal max/typ)"] == "200MHz"  # the main row's own value wins


def test_only_intel_records_are_enriched(dataset):
    amd = records(dataset)["amd|k6|amd-k6-200acr sl32a"]
    assert "Bus speed" not in amd.specs


def test_sspecs_missing_from_the_main_files_become_records(dataset):
    recs = records(dataset)
    extra = recs["sspec|sl27z"]
    assert extra.manufacturer == "Intel" and extra.family == "Celeron" and extra.model == "BX80523R300000 SL27Z"
    assert extra.part_number == "BX80523R300000 SL27Z" and extra.aliases == ["BX80523R300"]
    assert extra.specs == {"S-Spec": "SL27Z", "Frequency(internal max/typ)": "300MHz", "Bus speed": "66MHz", "L2 cache": "0KiB", "Package": "SEPP"}
    assert extra.provenance["from_sspec_table"] is True
    assert "sspec|sl32a" not in recs and "sspec|sy060" not in recs  # already covered by main rows


def test_without_the_table_nothing_changes(tmp_path):
    write_vendor(tmp_path, "Intel", [row("Intel", "Celeron", "X1 SL32A", {"Frequency(internal max/typ)": "300MHz"})])
    (rec,) = records(tmp_path).values()
    assert "Bus speed" not in rec.specs


def test_import_is_idempotent_and_the_version_covers_the_table(dataset, db):
    first = run_import(db, CpuDbAdapter(), dataset)
    assert first.errors == 0 and first.added == 4  # 3 main + 1 table-only
    again = run_import(db, CpuDbAdapter(), dataset)
    assert (again.added, again.changed, again.unchanged) == (0, 0, 4)
    version = CpuDbAdapter().source_version(dataset)
    write_sspecs(dataset, [{"Manufacturer": "Intel", "Family": "Celeron", "S-Spec number": "SL32A", "Bus speed": "100MHz"}])
    assert CpuDbAdapter().source_version(dataset) != version


def test_names_and_spec_lines_in_the_api(client, dataset, db, make_item, cats):
    run_import(db, CpuDbAdapter(), dataset)
    found = client.get(f"{API}/reference-suggestions", params={"q": "SL32A"}).json()
    ref = next(c["reference"] for c in found if "BX80524R300128" in c["reference"]["model"])
    # CPU-DB has no marketing names, so the name is built from family, speed and cache.
    assert ref["display_name"] == "Celeron 300MHz 128KiB L2"
    assert ref["spec_line"] == "SL32A · 300MHz · 66MHz bus · 128KiB L2 · SEPP Rev. 1"
    nocache = client.get(f"{API}/reference-suggestions", params={"q": "SL27Z"}).json()[0]["reference"]
    assert nocache["display_name"] == "Celeron 300MHz"  # no cache: not the "300A"
    assert nocache["spec_line"] == "SL27Z · 300MHz · 66MHz bus · no L2 · SEPP"


def test_linked_items_show_the_spec_line_in_lists_and_detail(client, dataset, db, make_item):
    run_import(db, CpuDbAdapter(), dataset)
    ref = db.scalar(select(ReferenceModel).where(ReferenceModel.model == "BX80524R300128 SL32A"))
    plain = make_item("no link")
    item = make_item("SL32A", manufacturer="Intel")
    client.post(f"{API}/items/{item['id']}/reference-match", json={"reference_model_id": ref.id})
    by_model = {i["model"]: i for i in client.get(f"{API}/items").json()["items"]}
    assert by_model["SL32A"]["spec_line"] == "SL32A · 300MHz · 66MHz bus · 128KiB L2 · SEPP Rev. 1"
    assert by_model["no link"]["spec_line"] is None
    assert client.get(f"{API}/items/{item['id']}").json()["spec_line"] == by_model["SL32A"]["spec_line"]
    assert client.get(f"{API}/items/{plain['id']}").json()["spec_line"] is None
    # Filters, sorting and pagination still work with the extra join.
    page = client.get(f"{API}/items", params={"q": "sl32a", "sort": "name", "with_total": True}).json()
    assert page["total"] == 1 and page["items"][0]["spec_line"]


def test_the_sspec_is_split_from_the_order_code(tmp_path):
    from app.reference.cpudb import split_sspec

    assert split_sspec("BX80524R300128 SL32A") == ("BX80524R300128", "SL32A")
    assert split_sspec("A80503150 Q0939") == ("A80503150", "Q0939")
    assert split_sspec("BP80521180 256K SL23L") == ("BP80521180 256K", "SL23L")
    assert split_sspec("A80501-60 Q0352") == ("A80501-60", "Q0352")
    # Not S-Specs: single words, plain words, codes without digits.
    for part in ("SL32A", "80486DX-33", "AMD-K6-200ACR", "KB80521EX180 SEPP", "Pentium MMX", "X1 ABCDE"):
        assert split_sspec(part)[1] is None, part


def test_intel_records_carry_their_sspec_as_a_spec(dataset):
    recs = records(dataset)
    assert recs["intel|celeron|bx80524r300128 sl32a"].specs["S-Spec"] == "SL32A"
    assert recs["intel|pentium|a80502200 sy060"].specs["S-Spec"] == "SY060"
    assert recs["sspec|sl27z"].specs["S-Spec"] == "SL27Z"  # table-only records too
    assert "S-Spec" not in recs["amd|k6|amd-k6-200acr sl32a"].specs  # S-Specs are Intel's


def test_detection_works_without_the_table(tmp_path):
    write_vendor(tmp_path, "Intel", [row("Intel", "Pentium", "A80503150 Q0939")])
    (rec,) = records(tmp_path).values()
    assert rec.specs["S-Spec"] == "Q0939"


def test_api_exposes_the_order_code_and_sspec_separately(client, dataset, db):
    run_import(db, CpuDbAdapter(), dataset)
    found = client.get(f"{API}/reference-suggestions", params={"q": "SL32A"}).json()
    ref = next(c["reference"] for c in found if c["reference"]["manufacturer"] == "Intel")
    assert ref["part_number"] == "BX80524R300128 SL32A"  # the whole printed string still matches
    assert (ref["order_code"], ref["s_spec"]) == ("BX80524R300128", "SL32A")
    plain = client.get(f"{API}/reference-suggestions", params={"q": "Pentium"}).json()
    assert all(c["reference"]["s_spec"] != "" for c in plain)
