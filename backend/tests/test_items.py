API = "/api/v1"


def test_quick_add_minimal_fields_uses_defaults(client, cats):
    r = client.post(f"{API}/items", json={"category_id": cats["GPU/VGA"], "model": "Unknown ISA VGA card"})
    assert r.status_code == 201
    item = r.json()
    assert item["inventory_code"] == "HW-000001"
    assert item["condition"] == "Unknown"
    assert item["test_status"] == "Untested"
    assert item["identification_confidence"] == "unidentified"
    assert item["location_id"] is None
    assert item["category_name"] == "GPU/VGA"
    assert item["photos"] == []


def test_inventory_codes_increment_and_are_never_reused(client, make_item):
    first = make_item("A")
    second = make_item("B")
    assert (first["inventory_code"], second["inventory_code"]) == ("HW-000001", "HW-000002")
    assert client.delete(f"{API}/items/{second['id']}").status_code == 204
    assert make_item("C")["inventory_code"] == "HW-000003"


def test_identical_cpus_are_tracked_independently(client, make_item, make_location):
    shelf_a = make_location("Shelf A")
    shelf_b = make_location("Shelf B")
    a = make_item("Pentium MMX 200", manufacturer="Intel", location_id=shelf_a["id"], condition="Good", test_status="Full Test")
    b = make_item("Pentium MMX 200", manufacturer="Intel", location_id=shelf_b["id"], condition="Poor", test_status="Dead")
    assert a["id"] != b["id"] and a["inventory_code"] != b["inventory_code"]
    assert client.get(f"{API}/items/{a['id']}").json()["test_status"] == "Full Test"
    assert client.get(f"{API}/items/{b['id']}").json()["location_path"] == "Shelf B"
    client.patch(f"{API}/items/{b['id']}", json={"test_status": "POST"})
    assert client.get(f"{API}/items/{a['id']}").json()["test_status"] == "Full Test"


def test_unknown_and_untested_are_distinct_and_filterable(client, make_item):
    make_item("a", test_status="Unknown", test_notes="Requires Socket 8 motherboard")
    make_item("b")  # Untested by default
    make_item("c", test_status="Untested")
    unknown = client.get(f"{API}/items", params={"test_status": "Unknown"}).json()["items"]
    untested = client.get(f"{API}/items", params={"test_status": "Untested"}).json()["items"]
    assert [i["model"] for i in unknown] == ["a"]
    assert sorted(i["model"] for i in untested) == ["b", "c"]
    detail = client.get(f"{API}/items/{unknown[0]['id']}").json()
    assert detail["test_notes"] == "Requires Socket 8 motherboard"


def test_condition_and_test_status_are_independent(client, make_item):
    item = make_item("x", condition="Excellent", test_status="Dead")
    assert (item["condition"], item["test_status"]) == ("Excellent", "Dead")


def test_validation_errors(client, cats):
    base = {"category_id": cats["CPU"], "model": "x"}
    assert client.post(f"{API}/items", json={"category_id": cats["CPU"]}).status_code == 422
    assert client.post(f"{API}/items", json={**base, "model": "   "}).status_code == 422
    assert client.post(f"{API}/items", json={**base, "condition": "Mint"}).status_code == 422
    assert client.post(f"{API}/items", json={**base, "test_status": "Works"}).status_code == 422
    assert client.post(f"{API}/items", json={**base, "category_id": 99999}).status_code == 422
    assert client.post(f"{API}/items", json={**base, "location_id": 99999}).status_code == 422
    assert client.post(f"{API}/items", json={**base, "acquired_on": "not-a-date"}).status_code == 422


def test_blank_optional_strings_become_null(client, make_item):
    item = make_item("x", manufacturer="  ", part_number="", notes="  hi  ")
    assert item["manufacturer"] is None and item["part_number"] is None and item["notes"] == "hi"


def test_patch_updates_only_given_fields_and_can_clear(client, make_item):
    item = make_item("Voodoo2", category="GPU/VGA", manufacturer="Diamond", notes="keep me")
    r = client.patch(f"{API}/items/{item['id']}", json={"manufacturer": None, "chipset": "Voodoo2", "chipset_manufacturer": "3dfx"})
    assert r.status_code == 200
    body = r.json()
    assert body["manufacturer"] is None
    assert body["chipset"] == "Voodoo2" and body["chipset_manufacturer"] == "3dfx"
    assert body["notes"] == "keep me"
    assert body["updated_at"] >= item["updated_at"]


def test_patch_rejects_null_for_required_fields(client, make_item):
    item = make_item("x")
    for field in ("model", "category_id", "condition", "test_status"):
        assert client.patch(f"{API}/items/{item['id']}", json={field: None}).status_code == 422


def test_category_specific_attributes_roundtrip(client, make_item):
    item = make_item("486DX2", attributes={"socket": "Socket 3", "mhz": 66})
    assert item["attributes"] == {"socket": "Socket 3", "mhz": 66}
    r = client.patch(f"{API}/items/{item['id']}", json={"attributes": {"socket": "Socket 3"}})
    assert r.json()["attributes"] == {"socket": "Socket 3"}


def test_get_by_code_and_404s(client, make_item):
    item = make_item("x")
    assert client.get(f"{API}/items/by-code/hw-000001").json()["id"] == item["id"]
    assert client.get(f"{API}/items/by-code/HW-999999").status_code == 404
    assert client.get(f"{API}/items/999999").status_code == 404
    assert client.patch(f"{API}/items/999999", json={"notes": "x"}).status_code == 404
    assert client.delete(f"{API}/items/999999").status_code == 404


def test_delete_item(client, make_item):
    item = make_item("x")
    assert client.delete(f"{API}/items/{item['id']}").status_code == 204
    assert client.get(f"{API}/items/{item['id']}").status_code == 404


def test_health(client):
    r = client.get(f"{API}/health")
    assert r.status_code == 200
    assert r.json()["database"] == "ok" and r.json()["storage"]["status"] == "ok"


def test_attribute_key_suggestions(client, make_item, cats):
    make_item("a", category="CPU", attributes={"Socket": "7", "Clock": "200"})
    make_item("b", category="CPU", attributes={"Socket": "8"})
    make_item("c", category="GPU/VGA", attributes={"VRAM": "4MB", "Socket": "n/a"})
    make_item("d")  # no attributes
    assert client.get(f"{API}/attribute-keys").json() == ["Socket", "Clock", "VRAM"]
    assert client.get(f"{API}/attribute-keys", params={"category_id": cats["CPU"]}).json() == ["Socket", "Clock"]
    assert client.get(f"{API}/attribute-keys", params={"category_id": cats["RAM"]}).json() == []
    assert client.get(f"{API}/attribute-keys", params={"limit": 1}).json() == ["Socket"]


def test_database_session_uses_the_configured_timezone(db):
    from sqlalchemy import text

    from app.config import get_settings

    assert db.scalar(text("SHOW timezone")) == get_settings().tz
