import json

from sqlalchemy import select, text

from app.models import Item, ReferenceModel
from app.reference.cpudb import CpuDbAdapter
from app.reference.runner import run_import
from tests.cpudb_data import row, write_sspecs, write_vendor

API = "/api/v1"


import pytest


@pytest.fixture
def cpu(tmp_path, db):
    write_vendor(
        tmp_path,
        "Intel",
        [row("Intel", "Celeron", "BX80524R300128 SL32A", {"Frequency(internal max/typ)": "300MHz", "L2 cache": "128KiB", "Package": "SEPP Rev. 1", "Socket": "Slot 1", "Core Stepping": "B0", "Comments": "not copied", "Reference 1": "http://example.test/SL32A", "Process Size": "NA"})],
    )
    write_sspecs(tmp_path, [{"Manufacturer": "Intel", "Family": "Celeron", "S-Spec number": "SL32A", "Bus speed": "66MHz"}])
    run_import(db, CpuDbAdapter(), tmp_path)
    return db.scalar(select(ReferenceModel).where(ReferenceModel.model == "BX80524R300128 SL32A"))


def test_picking_a_match_when_creating_puts_the_specs_on_the_item(client, cats, cpu):
    r = client.post(f"{API}/items", json={"category_id": cats["CPU"], "model": "Celeron 300MHz 128KiB L2", "reference_model_id": cpu.id, "identification_confidence": "confirmed"})
    attrs = r.json()["attributes"]
    assert attrs == {
        "Family": "Celeron", "S-Spec": "SL32A", "Speed": "300MHz", "L2 cache": "128KiB", "Package": "SEPP Rev. 1", "Socket": "Slot 1",
        "Stepping": "B0", "Bus speed": "66MHz", "Source link": "http://example.test/SL32A", "Source": "CPU-DB",
    }  # plain names; NA, comments and the chip-type column are left out


def test_values_the_user_typed_win_over_the_copied_ones(client, cats, cpu):
    r = client.post(f"{API}/items", json={"category_id": cats["CPU"], "model": "x", "reference_model_id": cpu.id, "attributes": {"speed": "my 300"}})
    attrs = r.json()["attributes"]
    assert attrs["speed"] == "my 300" and "Speed" not in attrs  # compared case-insensitively
    assert attrs["Package"] == "SEPP Rev. 1"


def test_copies_in_a_batch_each_carry_the_specs(client, cats, cpu):
    r = client.post(f"{API}/items/batch", json={"item": {"category_id": cats["CPU"], "model": "x", "reference_model_id": cpu.id}, "copies": 3})
    for created in r.json()["created"]:
        assert client.get(f"{API}/items/{created['id']}").json()["attributes"]["Bus speed"] == "66MHz"


def test_linking_an_existing_item_fills_only_what_is_missing(client, make_item, cpu):
    item = make_item("SL32A", manufacturer="Intel", attributes={"Package": "my own package"})
    r = client.post(f"{API}/items/{item['id']}/reference-match", json={"reference_model_id": cpu.id})
    attrs = r.json()["attributes"]
    assert attrs["Package"] == "my own package" and attrs["Speed"] == "300MHz"
    # Edit the copy, link again: the edit survives, only gaps are filled.
    client.patch(f"{API}/items/{item['id']}", json={"attributes": {**attrs, "Speed": "300 MHz (checked)"}})
    again = client.post(f"{API}/items/{item['id']}/reference-match", json={"reference_model_id": cpu.id}).json()
    assert again["attributes"]["Speed"] == "300 MHz (checked)"


def test_linking_can_skip_the_copy_and_unlinking_keeps_the_specs(client, make_item, cpu):
    item = make_item("a")
    r = client.post(f"{API}/items/{item['id']}/reference-match", json={"reference_model_id": cpu.id, "copy_specs": False})
    assert r.json()["attributes"] == {}
    client.post(f"{API}/items/{item['id']}/reference-match", json={"reference_model_id": cpu.id})
    after = client.delete(f"{API}/items/{item['id']}/reference-match").json()
    assert after["reference"] is None and after["attributes"]["Speed"] == "300MHz"


def test_the_spec_line_comes_from_the_items_own_specs(client, cats, cpu, db):
    r = client.post(f"{API}/items", json={"category_id": cats["CPU"], "model": "x", "reference_model_id": cpu.id}).json()
    assert r["spec_line"] == "SL32A · 300MHz · 66MHz bus · 128KiB L2 · SEPP Rev. 1"
    edited = client.patch(f"{API}/items/{r['id']}", json={"attributes": {**r["attributes"], "Speed": "333MHz"}}).json()
    assert edited["spec_line"].startswith("SL32A · 333MHz")  # the item's data, not the dataset's
    # Old matches without copied specs still show a line, from the record.
    old = client.post(f"{API}/items", json={"category_id": cats["CPU"], "model": "old"}).json()
    db.execute(text("UPDATE items SET reference_model_id = :r WHERE id = :i"), {"r": cpu.id, "i": old["id"]})
    db.commit()
    listed = {i["model"]: i for i in client.get(f"{API}/items").json()["items"]}
    assert listed["old"]["spec_line"] == "SL32A · 300MHz · 66MHz bus · 128KiB L2 · SEPP Rev. 1"


def test_specs_are_searchable(client, make_item, cpu):
    plain = make_item("plain")
    linked = make_item("SL32A", attributes={"Socket": "Slot 1", "Package": "SEPP Rev. 1", "VRAM": "4MB"})
    names = lambda q: [i["model"] for i in client.get(f"{API}/items", params={"q": q}).json()["items"]]
    assert names("sepp") == ["SL32A"] and names("vram 4mb") == ["SL32A"] and names("slot 1") == ["SL32A"]
    assert names("sepp") != [plain["model"]]
    client.patch(f"{API}/items/{linked['id']}", json={"attributes": {}})
    assert names("sepp") == []


def test_specs_travel_through_csv(client, cats, cpu):
    client.post(f"{API}/items", json={"category_id": cats["CPU"], "model": "round trip", "reference_model_id": cpu.id})
    exported = client.get(f"{API}/export/items.csv").content
    assert b"specs" in exported.splitlines()[0] and b"SEPP Rev. 1" in exported
    for item in client.get(f"{API}/items").json()["items"]:
        client.delete(f"{API}/items/{item['id']}")
    r = client.post(f"{API}/import/items.csv", params={"commit": True}, files={"file": ("x.csv", exported, "text/csv")})
    assert r.json()["imported"] == 1
    got = client.get(f"{API}/items").json()["items"][0]
    assert client.get(f"{API}/items/{got['id']}").json()["attributes"]["Bus speed"] == "66MHz"


def test_import_validates_specs(client):
    bad = client.post(f"{API}/import/items.csv", files={"file": ("x.csv", b'category,model,specs\nCPU,x,"not json"\nCPU,y,"[1,2]"\nCPU,z,"{""Socket"": ""7""}"\n', "text/csv")})
    report = bad.json()
    assert report["error_rows"] == 2 and report["valid_rows"] == 1
    assert all("specs must be a JSON object" in e["message"] for e in report["errors"])


def test_linking_tidies_a_part_number_that_is_the_combined_string(client, make_item, cpu):
    item = make_item("old style", part_number="BX80524R300128 SL32A")
    r = client.post(f"{API}/items/{item['id']}/reference-match", json={"reference_model_id": cpu.id}).json()
    assert r["part_number"] == "BX80524R300128" and r["attributes"]["S-Spec"] == "SL32A"
    # A part number the user wrote differently is left alone.
    other = make_item("mine", part_number="my own number")
    kept = client.post(f"{API}/items/{other['id']}/reference-match", json={"reference_model_id": cpu.id}).json()
    assert kept["part_number"] == "my own number"


def test_an_items_sspec_spec_also_finds_the_record(client, make_item, cpu):
    item = make_item("some chip", part_number="BX80524R300128", attributes={"S-Spec": "SL32A"})
    found = client.get(f"{API}/items/{item['id']}/reference-candidates").json()
    assert found and found[0]["reference"]["model"] == "BX80524R300128 SL32A" and found[0]["match_type"] == "exact"
