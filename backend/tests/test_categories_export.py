import csv
import io

API = "/api/v1"


def test_seed_categories_exist(client):
    names = [c["name"] for c in client.get(f"{API}/categories").json()]
    assert names == ["CPU", "GPU/VGA", "Motherboard", "Sound Card", "RAM", "Storage", "Other"]


def test_category_crud_and_rules(client, make_item, cats):
    created = client.post(f"{API}/categories", json={"name": "Network Card"})
    assert created.status_code == 201
    cid = created.json()["id"]
    assert client.post(f"{API}/categories", json={"name": "network card"}).status_code == 409
    assert client.patch(f"{API}/categories/{cid}", json={"name": "NIC"}).json()["name"] == "NIC"
    assert client.patch(f"{API}/categories/{cid}", json={"name": "CPU"}).status_code == 409
    assert client.patch(f"{API}/categories/{cid}", json={"name": None}).status_code == 422

    make_item("x", category="CPU")
    assert client.delete(f"{API}/categories/{cats['CPU']}").status_code == 409
    assert client.delete(f"{API}/categories/{cid}").status_code == 204
    assert client.delete(f"{API}/categories/{cid}").status_code == 404


def parse(response):
    assert response.headers["content-type"].startswith("text/csv")
    return list(csv.DictReader(io.StringIO(response.text)))


def test_csv_export_contains_ids_paths_and_statuses(client, make_item, make_location):
    box = make_location("Shelf")
    box = make_location("Box", box["id"])
    make_item("Pentium", manufacturer="Intel", location_id=box["id"], condition="Good", test_status="POST", test_notes="boots, 'quoted' \"text\"", notes="line1\nline2")
    make_item("Unknown PCI video card", category="GPU/VGA")
    r = client.get(f"{API}/export/items.csv")
    assert "attachment" in r.headers["content-disposition"]
    rows = parse(r)
    assert [row["inventory_code"] for row in rows] == ["HW-000001", "HW-000002"]
    first = rows[0]
    assert first["category"] == "CPU" and first["location"] == "Shelf > Box"
    assert first["condition"] == "Good" and first["test_status"] == "POST"
    assert first["test_notes"] == "boots, 'quoted' \"text\"" and first["notes"] == "line1\nline2"
    assert rows[1]["location"] == "" and rows[1]["test_status"] == "Untested"


def test_csv_export_honours_filters(client, make_item):
    make_item("keep", test_status="Dead")
    make_item("drop")
    rows = parse(client.get(f"{API}/export/items.csv", params={"test_status": "Dead"}))
    assert [r["model"] for r in rows] == ["keep"]


def test_csv_export_neutralises_formulas(client, make_item):
    make_item("=HYPERLINK(\"http://evil\")", manufacturer="@x")
    row = parse(client.get(f"{API}/export/items.csv"))[0]
    assert row["model"].startswith("'=") and row["manufacturer"] == "'@x"


def test_csv_export_streams_many_rows(client, db):
    from sqlalchemy import text

    db.execute(text("INSERT INTO items (category_id, model) SELECT (SELECT min(id) FROM categories), 'bulk ' || g FROM generate_series(1, 2500) g"))
    db.commit()
    assert len(parse(client.get(f"{API}/export/items.csv"))) == 2500


def test_seeded_categories_come_with_their_own_fields(client):
    by_name = {c["name"]: c for c in client.get(f"{API}/categories").json()}
    cpu = [f["name"] for f in by_name["CPU"]["fields"]]
    assert cpu[:6] == ["Family", "S-Spec", "Speed", "Bus speed", "L2 cache", "Socket"] and "Chipset" not in cpu
    gpu = {f["name"]: f["column"] for f in by_name["GPU/VGA"]["fields"]}
    assert gpu["Chipset maker"] == "chipset_manufacturer" and gpu["Chipset"] == "chipset" and gpu["Memory size"] is None
    assert by_name["Other"]["fields"] == []


def test_editing_a_categorys_fields(client, cats):
    fields = [{"name": "Socket", "hint": "e.g. Socket 7"}, {"name": "Clock", "hint": ""}, {"name": "Chipset", "column": "chipset"}]
    r = client.patch(f"{API}/categories/{cats['Other']}", json={"fields": fields})
    assert r.status_code == 200
    assert r.json()["fields"] == [
        {"name": "Socket", "hint": "e.g. Socket 7", "column": None},
        {"name": "Clock", "hint": "", "column": None},
        {"name": "Chipset", "hint": "", "column": "chipset"},
    ]
    assert client.patch(f"{API}/categories/{cats['Other']}", json={"name": "Misc"}).json()["fields"][0]["name"] == "Socket"  # other edits keep them
    created = client.post(f"{API}/categories", json={"name": "Network Card", "fields": [{"name": "Speed"}]})
    assert created.status_code == 201 and created.json()["fields"][0]["name"] == "Speed"


def test_field_validation(client, cats):
    url = f"{API}/categories/{cats['Other']}"
    assert client.patch(url, json={"fields": [{"name": "A"}, {"name": "a"}]}).status_code == 422  # duplicate
    assert client.patch(url, json={"fields": [{"name": ""}]}).status_code == 422
    assert client.patch(url, json={"fields": [{"name": "x", "column": "model"}]}).status_code == 422
    two = [{"name": "A", "column": "chipset"}, {"name": "B", "column": "chipset"}]
    assert client.patch(url, json={"fields": two}).status_code == 422
    assert client.patch(url, json={"fields": [{"name": f"F{i}"} for i in range(41)]}).status_code == 422
    assert client.patch(url, json={"fields": None}).status_code == 422


def test_value_suggestions_for_a_spec(client, make_item, cats):
    make_item("a", category="CPU", attributes={"Socket": "Socket 7"})
    make_item("b", category="CPU", attributes={"Socket": "Socket 7"})
    make_item("c", category="CPU", attributes={"Socket": "Socket 8"})
    make_item("d", category="GPU/VGA", attributes={"Socket": "n/a"})
    make_item("e", category="CPU", attributes={"Socket": ""})
    everywhere = client.get(f"{API}/attribute-values", params={"key": "Socket"}).json()
    assert everywhere[0] == "Socket 7" and sorted(everywhere) == sorted(["Socket 7", "Socket 8", "n/a"])  # most used first
    assert client.get(f"{API}/attribute-values", params={"key": "Socket", "category_id": cats["CPU"]}).json() == ["Socket 7", "Socket 8"]
    assert client.get(f"{API}/attribute-values", params={"key": "Nope"}).json() == []
    assert client.get(f"{API}/attribute-values", params={"key": "Socket", "limit": 1}).json() == ["Socket 7"]
