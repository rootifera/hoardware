import csv
import io

API = "/api/v1"


def lookup(client, code):
    return client.get(f"{API}/items/lookup", params={"code": code}).json()


def test_an_item_can_carry_its_original_barcode(client, cats):
    plain = client.post(f"{API}/items", json={"category_id": cats["CPU"], "model": "Pentium"}).json()
    boxed = client.post(f"{API}/items", json={"category_id": cats["CPU"], "model": "Boxed", "barcode": " 5012345678900 "}).json()
    assert plain["barcode"] is None and boxed["barcode"] == "5012345678900"  # trimmed
    assert client.patch(f"{API}/items/{plain['id']}", json={"barcode": "ABC-123"}).json()["barcode"] == "ABC-123"
    assert client.patch(f"{API}/items/{plain['id']}", json={"barcode": ""}).json()["barcode"] is None  # blank clears it
    listed = {i["id"]: i["barcode"] for i in client.get(f"{API}/items").json()["items"]}
    assert listed[boxed["id"]] == "5012345678900"


def test_barcode_validation(client, cats):
    for bad in ("x" * 101, "two\nlines", "tab\there", "ünïcode"):
        r = client.post(f"{API}/items", json={"category_id": cats["CPU"], "model": "x", "barcode": bad})
        assert r.status_code == 422, repr(bad)


def test_a_scan_finds_by_inventory_code_or_by_original_barcode(client, cats):
    a = client.post(f"{API}/items", json={"category_id": cats["CPU"], "model": "A", "barcode": "5012345678900"}).json()
    b = client.post(f"{API}/items", json={"category_id": cats["CPU"], "model": "B"}).json()
    assert [m["id"] for m in lookup(client, a["inventory_code"])] == [a["id"]]
    assert [m["id"] for m in lookup(client, b["inventory_code"].lower())] == [b["id"]]  # case does not matter
    assert [m["id"] for m in lookup(client, "5012345678900")] == [a["id"]]
    assert lookup(client, "0000000000000") == []
    # Identical boxed items share a barcode: a scan returns all of them so nobody is picked for you.
    c = client.post(f"{API}/items", json={"category_id": cats["CPU"], "model": "A again", "barcode": "5012345678900"}).json()
    assert [m["id"] for m in lookup(client, "5012345678900")] == [a["id"], c["id"]]
    assert client.get(f"{API}/items/lookup").status_code == 422


def test_search_finds_the_barcode_too(client, cats):
    a = client.post(f"{API}/items", json={"category_id": cats["CPU"], "model": "Boxed thing", "barcode": "5012345678900"}).json()
    client.post(f"{API}/items", json={"category_id": cats["CPU"], "model": "Other"})
    assert [i["id"] for i in client.get(f"{API}/items", params={"q": "5012345678900"}).json()["items"]] == [a["id"]]


def test_labels_use_the_barcode_or_fall_back_to_the_code(client, cats):
    boxed = client.post(f"{API}/items", json={"category_id": cats["CPU"], "model": "Boxed", "barcode": "5012345678900"}).json()
    plain = client.post(f"{API}/items", json={"category_id": cats["CPU"], "model": "Plain"}).json()
    got = {x["id"]: x for x in client.post(f"{API}/items/labels", json={"ids": [boxed["id"], plain["id"]]}).json()}
    assert got[boxed["id"]]["barcode"] == "5012345678900" and got[boxed["id"]]["inventory_code"] == boxed["inventory_code"]
    assert got[plain["id"]]["barcode"] == plain["inventory_code"]  # nothing entered: the item's own code


def test_csv_carries_the_barcode(client, cats):
    client.post(f"{API}/items", json={"category_id": cats["CPU"], "model": "Boxed", "barcode": "5012345678900"})
    rows = list(csv.DictReader(io.StringIO(client.get(f"{API}/export/items.csv").text)))
    assert rows[0]["barcode"] == "5012345678900"
    assert "barcode" in client.get(f"{API}/import/template.csv").text.splitlines()[0]
    body = "category,model,ean\nCPU,Imported,4006381333931\nCPU,No code,\n"
    assert client.post(f"{API}/import/items.csv", params={"commit": "true"}, files={"file": ("x.csv", body, "text/csv")}).json()["imported"] == 2
    got = {i["model"]: i["barcode"] for i in client.get(f"{API}/items").json()["items"]}
    assert got["Imported"] == "4006381333931" and got["No code"] is None
