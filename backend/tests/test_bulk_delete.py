import csv
import io

from app.models import Item, PendingDeletion

API = "/api/v1"


def upload_file(client, item_id, name="a.bin", data=b"data"):
    return client.post(f"{API}/items/{item_id}/files", files=[("files", (name, data, "application/octet-stream"))], data={"kind": "tool"})


def stored(photos_dir):
    return sorted(p for p in photos_dir.rglob("*") if p.is_file())


def test_dry_run_counts_and_changes_nothing(client, make_item):
    ids = [make_item(f"x{i}")["id"] for i in range(3)]
    r = client.post(f"{API}/items/bulk-delete", json={"selection": {"ids": ids[:2]}, "dry_run": True})
    assert r.json() == {"matched": 2, "deleted": 0, "dry_run": True}
    assert client.get(f"{API}/items", params={"with_total": "true"}).json()["total"] == 3


def test_delete_selected_ids_removes_items_and_their_files(client, make_item, photos_dir):
    a, b, keep = (make_item(n)["id"] for n in ("a", "b", "keep"))
    assert upload_file(client, a).status_code == 201 and upload_file(client, keep, "k.bin").status_code == 201
    assert len(stored(photos_dir)) == 2
    r = client.post(f"{API}/items/bulk-delete", json={"selection": {"ids": [a, b]}})
    assert r.status_code == 200 and r.json()["deleted"] == 2
    assert client.get(f"{API}/items/{a}").status_code == 404 and client.get(f"{API}/items/{b}").status_code == 404
    assert client.get(f"{API}/items/{keep}").status_code == 200
    names = [p.name for p in stored(photos_dir)]
    assert names == ["k.bin"]  # the deleted item's file is gone from storage, the other one is kept


def test_delete_by_filter_with_exclusions(client, make_item):
    ids = [make_item(f"Widget {i}")["id"] for i in range(5)]
    make_item("Other thing")
    body = {"selection": {"filter": {"q": "widget", "category_id": [], "condition": [], "test_status": [], "identification_confidence": [], "include_descendants": True, "unassigned": False, "never_verified": False}, "exclude_ids": [ids[0]]}}
    r = client.post(f"{API}/items/bulk-delete", json=body)
    assert r.json()["deleted"] == 4
    remaining = {i["model"] for i in client.get(f"{API}/items").json()["items"]}
    assert remaining == {"Widget 0", "Other thing"}


def test_failed_storage_cleanup_is_queued_not_lost(client, make_item, db, monkeypatch):
    from app.storage import StorageError, build_storage

    item = make_item("x")["id"]
    upload_file(client, item)
    storage = build_storage("local")

    def boom(self, key):
        raise StorageError("down")

    monkeypatch.setattr(type(storage), "delete", boom)
    assert client.post(f"{API}/items/bulk-delete", json={"selection": {"ids": [item]}}).status_code == 200
    assert db.query(Item).count() == 0
    assert db.query(PendingDeletion).count() == 1  # storage-gc retries it later


def test_nothing_selected_is_a_noop(client):
    r = client.post(f"{API}/items/bulk-delete", json={"selection": {"ids": [999999]}})
    assert r.json() == {"matched": 0, "deleted": 0, "dry_run": False}


def test_export_selected_only(client, make_item):
    a = make_item("Alpha")["id"]
    make_item("Beta")
    c = make_item("Gamma", manufacturer="=cmd|'x'")["id"]
    r = client.post(f"{API}/items/bulk-export", json={"ids": [a, c]})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    assert "attachment" in r.headers["content-disposition"]
    rows = list(csv.DictReader(io.StringIO(r.text)))
    assert [x["model"] for x in rows] == ["Alpha", "Gamma"]
    assert rows[1]["manufacturer"].startswith("'=")  # formula protection still applies
