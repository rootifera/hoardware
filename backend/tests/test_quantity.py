import csv
import io

API = "/api/v1"


def test_items_are_single_by_default_and_stock_items_are_counted(client, cats):
    one = client.post(f"{API}/items", json={"category_id": cats["CPU"], "model": "Pentium"}).json()
    assert one["is_stock"] is False and one["quantity"] == 1
    stock = client.post(f"{API}/items", json={"category_id": cats["Other"], "model": "100nF capacitor", "is_stock": True, "quantity": 100}).json()
    assert stock["is_stock"] is True and stock["quantity"] == 100
    listed = {i["id"]: i for i in client.get(f"{API}/items").json()["items"]}
    assert listed[stock["id"]]["is_stock"] and listed[stock["id"]]["quantity"] == 100 and not listed[one["id"]]["is_stock"]


def test_quantity_can_be_changed_used_up_and_the_flag_switched(client, make_item):
    item = make_item("Resistor 10k", is_stock=True, quantity=250)
    assert client.patch(f"{API}/items/{item['id']}", json={"quantity": 240}).json()["quantity"] == 240
    assert client.patch(f"{API}/items/{item['id']}", json={"quantity": 0}).json()["quantity"] == 0  # all used: the record stays
    assert client.patch(f"{API}/items/{item['id']}", json={"model": "Resistor 10k 1%"}).json()["quantity"] == 0  # other edits keep it
    off = client.patch(f"{API}/items/{item['id']}", json={"is_stock": False}).json()
    assert off["is_stock"] is False and off["quantity"] == 0  # switching it off keeps the number


def test_validation(client, cats):
    for bad in (-1, 1_000_000_001, 1.5, "lots"):
        r = client.post(f"{API}/items", json={"category_id": cats["Other"], "model": "x", "is_stock": True, "quantity": bad})
        assert r.status_code == 422, bad
    item = client.post(f"{API}/items", json={"category_id": cats["Other"], "model": "x"}).json()
    for patch in ({"quantity": None}, {"quantity": -5}, {"is_stock": None}):
        assert client.patch(f"{API}/items/{item['id']}", json=patch).status_code == 422, patch


def test_several_separate_items_each_get_the_stock_settings(client, cats):
    r = client.post(f"{API}/items/batch", json={"item": {"category_id": cats["Other"], "model": "Bin", "is_stock": True, "quantity": 20}, "copies": 3})
    assert r.status_code == 201
    got = [(i["is_stock"], i["quantity"]) for i in client.get(f"{API}/items", params={"q": "bin"}).json()["items"]]
    assert got == [(True, 20)] * 3


def test_stock_is_a_category_default_setting(client, cats):
    r = client.patch(f"{API}/categories/{cats['Other']}", json={"settings": {"core": {"stock": {"show": True}}}})
    assert r.status_code == 200 and r.json()["settings"]["core"]["stock"] == {"show": True}
    # The old key is no longer a standard field.
    assert client.patch(f"{API}/categories/{cats['Other']}", json={"settings": {"core": {"quantity": {"show": True}}}}).status_code == 422


def test_export_and_import(client, cats):
    client.post(f"{API}/items", json={"category_id": cats["Other"], "model": "Capacitor 100nF", "is_stock": True, "quantity": 500})
    client.post(f"{API}/items", json={"category_id": cats["CPU"], "model": "Pentium MMX"})
    rows = {r["model"]: r for r in csv.DictReader(io.StringIO(client.get(f"{API}/export/items.csv").text))}
    assert rows["Capacitor 100nF"]["quantity"] == "500" and rows["Pentium MMX"]["quantity"] == ""  # blank: not counted
    assert "quantity" in client.get(f"{API}/import/template.csv").text.splitlines()[0]
    body = "category,model,qty\nOther,Washer M3,1000\nOther,Single thing,\n"
    imported = client.post(f"{API}/import/items.csv", params={"commit": "true"}, files={"file": ("x.csv", body, "text/csv")}).json()
    assert imported["imported"] == 2, imported
    got = {i["model"]: (i["is_stock"], i["quantity"]) for i in client.get(f"{API}/items").json()["items"]}
    assert got["Washer M3"] == (True, 1000) and got["Single thing"] == (False, 1)  # a quantity makes it stock; blank does not


def test_import_rejects_a_bad_quantity(client):
    body = "category,model,quantity\nOther,Washer,many\nOther,Nut,-3\n"
    r = client.post(f"{API}/import/items.csv", params={"commit": "false"}, files={"file": ("x.csv", body, "text/csv")}).json()
    assert r["error_rows"] == 2 and all("quantity" in e["message"] for e in r["errors"])


def test_starter_sets_start_stock_items_where_it_fits():
    from app.services import presets

    on = {key: [c["name"] for c in p["categories"] if c["settings"]["core"].get("stock", {}).get("show")] for key, p in presets.load_all().items()}
    assert on["electronics"] == ["Components", "Tools & accessories"]
    assert on["pc"] == [] and on["blank"] == []  # PC hardware stays one record per physical item
