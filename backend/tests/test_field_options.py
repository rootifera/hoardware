import importlib.util
from pathlib import Path

API = "/api/v1"

_spec = importlib.util.spec_from_file_location("opts", Path(__file__).resolve().parent.parent / "alembic/versions/0012_field_options.py")
migration = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(migration)


def field(client, category, name):
    cat = next(c for c in client.get(f"{API}/categories").json() if c["name"].lower() == category)
    return next(f for f in cat["fields"] if f["name"] == name)


def test_ram_and_storage_start_with_predefined_values(client):
    assert {"SDRAM", "EDO", "DDR2"} <= set(field(client, "ram", "Type")["options"])
    assert "128MB" in field(client, "ram", "Capacity")["options"]
    assert "PC133" in field(client, "ram", "Speed")["options"]
    assert field(client, "ram", "ECC")["options"] == ["Yes", "No", "Parity"]
    assert "SCSI" in field(client, "storage", "Interface")["options"]
    assert "7200" in field(client, "storage", "RPM")["options"]
    assert field(client, "cpu", "Family")["options"] == []  # free text stays free text


def test_options_can_be_edited_and_values_outside_them_are_accepted(client, make_item):
    ram = next(c for c in client.get(f"{API}/categories").json() if c["name"] == "RAM")
    fields = [{**f, "options": ["Only", "These"]} if f["name"] == "Type" else f for f in ram["fields"]]
    r = client.patch(f"{API}/categories/{ram['id']}", json={"fields": fields})
    assert r.status_code == 200
    assert field(client, "ram", "Type")["options"] == ["Only", "These"]
    # An option is a suggestion, not a rule: a custom value saves fine.
    item = make_item("odd stick", category="RAM", attributes={"Type": "Something else"})
    assert item["attributes"]["Type"] == "Something else"


def test_option_validation(client):
    ram = next(c for c in client.get(f"{API}/categories").json() if c["name"] == "RAM")
    base = ram["fields"]
    bad = [{**base[0], "options": ["A", "a"]}, *base[1:]]
    assert client.patch(f"{API}/categories/{ram['id']}", json={"fields": bad}).status_code == 422
    bad = [{**base[0], "options": [f"v{i}" for i in range(61)]}, *base[1:]]
    assert client.patch(f"{API}/categories/{ram['id']}", json={"fields": bad}).status_code == 422
    bad = [{**base[0], "options": ["x" * 81]}, *base[1:]]
    assert client.patch(f"{API}/categories/{ram['id']}", json={"fields": bad}).status_code == 422
    # Blank entries are dropped by the client; the API refuses them.
    bad = [{**base[0], "options": [""]}, *base[1:]]
    assert client.patch(f"{API}/categories/{ram['id']}", json={"fields": bad}).status_code == 422


def test_migration_adds_options_only_where_there_are_none():
    mine = {"name": "Type", "hint": "", "column": None, "options": ["Mine"]}
    fresh = {"name": "Capacity", "hint": "", "column": None}
    out = migration.with_options("RAM", [mine, fresh, {"name": "Unrelated", "hint": "", "column": None}])
    assert out[0]["options"] == ["Mine"]  # the user's own list is kept
    assert "128MB" in out[1]["options"]
    assert "options" not in out[2]
