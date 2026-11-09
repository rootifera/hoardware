import pytest

from app.config import get_settings
from app.services import presets

API = "/api/v1"
KEYS = ["pc", "music", "cards", "electronics", "blank"]


def names(client):
    return [c["name"] for c in client.get(f"{API}/categories").json()]


def test_every_starter_set_is_valid_and_listed():
    loaded = presets.load_all()  # validates every category like one entered by hand
    assert list(loaded) == KEYS
    for key, preset in loaded.items():
        assert preset["name"] and preset["description"] and preset["categories"], key
        cat_names = [c["name"].lower() for c in preset["categories"]]
        assert len(cat_names) == len(set(cat_names)), f"{key} repeats a category"
        assert 1 <= len(preset["code_prefix"]) <= 6 and preset["code_prefix"].isalnum() and preset["code_prefix"].isupper()
    # The PC set is exactly what a standard install starts with.
    assert [c["name"] for c in loaded["pc"]["categories"]] == ["CPU", "GPU/VGA", "Motherboard", "Sound Card", "RAM", "Storage", "Other"]


def test_a_fresh_install_has_not_been_set_up(client):
    r = client.get(f"{API}/setup").json()
    assert r["complete"] is False and r["title"] == "Hoardware" and r["code_prefix"] == "HW"
    assert [p["key"] for p in r["presets"]] == KEYS


def test_standard_keeps_the_pc_categories_and_cannot_be_repeated(client):
    before = names(client)
    r = client.post(f"{API}/setup", json={"mode": "standard"})
    assert r.status_code == 200 and r.json()["complete"] is True
    assert names(client) == before
    assert client.post(f"{API}/setup", json={"mode": "standard"}).status_code == 409
    assert client.post(f"{API}/setup", json={"mode": "custom", "preset": "music"}).status_code == 409  # no second chance


def test_custom_replaces_the_categories_and_changes_the_code_prefix(client):
    r = client.post(f"{API}/setup", json={"mode": "custom", "preset": "music", "title": "My Studio", "code_prefix": "mg"})
    assert r.status_code == 200, r.text
    assert r.json()["title"] == "My Studio" and r.json()["code_prefix"] == "MG" and r.json()["complete"] is True
    assert names(client)[:3] == ["Synthesizers", "Effects pedals", "Amplifiers"] and "CPU" not in names(client)
    synth = next(c for c in client.get(f"{API}/categories").json() if c["name"] == "Synthesizers")
    assert synth["settings"]["core"]["test_status"]["label"] == "Works?"
    assert any(f["name"] == "Type" and "Analog" in f["options"] for f in synth["fields"])

    item = client.post(f"{API}/items", json={"category_id": synth["id"], "model": "Juno-60"}).json()
    assert item["inventory_code"] == "MG-000001"
    second = client.post(f"{API}/items", json={"category_id": synth["id"], "model": "Jupiter-8"}).json()
    assert second["inventory_code"] == "MG-000002"
    # Typing just the number finds it, whatever the prefix is.
    assert [i["inventory_code"] for i in client.get(f"{API}/items", params={"q": "2"}).json()["items"]] == ["MG-000002"]
    assert client.get(f"{API}/setup").json()["title"] == "My Studio"


def test_custom_blank_and_defaults(client):
    r = client.post(f"{API}/setup", json={"mode": "custom"})
    assert r.status_code == 200 and names(client) == ["Items"] and r.json()["code_prefix"] == "IT" and r.json()["title"] == "Hoardware"


def test_custom_validation(client, make_item):
    assert client.post(f"{API}/setup", json={"mode": "custom", "preset": "nope"}).status_code == 422
    for bad in ("TOOLONGPREFIX", "A-B", "!!", "a b"):
        assert client.post(f"{API}/setup", json={"mode": "custom", "preset": "cards", "code_prefix": bad}).status_code == 422, bad
    assert client.get(f"{API}/setup").json()["complete"] is False  # nothing was done by the refused attempts
    # A custom setup would wipe the categories, so it needs an empty inventory.
    make_item("something")
    assert client.post(f"{API}/setup", json={"mode": "custom", "preset": "cards"}).status_code == 409
    # Standard is fine with items around.
    assert client.post(f"{API}/setup", json={"mode": "standard"}).status_code == 200


def test_a_failed_custom_setup_changes_nothing(client, monkeypatch):
    before = names(client)

    def boom(session, key):
        raise RuntimeError("boom")

    monkeypatch.setattr(presets, "apply", boom)
    with pytest.raises(RuntimeError):
        client.post(f"{API}/setup", json={"mode": "custom", "preset": "music"})
    assert names(client) == before and client.get(f"{API}/setup").json()["complete"] is False


def test_starter_sets_can_be_added_later_without_touching_what_exists(client):
    client.post(f"{API}/setup", json={"mode": "custom", "preset": "blank"})
    assert names(client) == ["Items"]
    added = client.post(f"{API}/presets/pc/apply").json()["added"]
    assert added == ["CPU", "GPU/VGA", "Motherboard", "Sound Card", "RAM", "Storage", "Other"]
    cpu = next(c for c in client.get(f"{API}/categories").json() if c["name"] == "CPU")
    assert any(f["name"] == "S-Spec" for f in cpu["fields"])
    # Doing it again, or adding a set that overlaps ("Other"), only adds what is missing.
    assert client.post(f"{API}/presets/pc/apply").json()["added"] == []
    assert client.post(f"{API}/presets/music/apply").json()["added"] == ["Synthesizers", "Effects pedals", "Amplifiers", "Guitars & basses", "Studio & outboard", "Cables & accessories"]
    assert client.post(f"{API}/presets/nope/apply").status_code == 404
    order = names(client)
    assert order.index("Items") < order.index("CPU") < order.index("Synthesizers")  # new ones go to the end


def test_setup_needs_login_when_login_is_on(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "auth_password", "pw")
    assert client.get(f"{API}/setup").status_code == 401
    assert client.post(f"{API}/setup", json={"mode": "standard"}).status_code == 401
    assert client.get(f"{API}/presets").status_code == 401


def test_no_starter_set_has_a_field_that_duplicates_the_quantity():
    # Quantity belongs to "Track as stock", not to a text field of its own.
    for key, preset in presets.load_all().items():
        for category in preset["categories"]:
            for f in category["fields"]:
                assert f["name"].lower() not in ("quantity", "qty", "count", "amount"), (key, category["name"], f["name"])
