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
