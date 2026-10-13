from app.models import PendingDeletion
from app.storage import build_storage
from app.storage.base import StorageError

API = "/api/v1"


def upload(client, item_id, *files, **data):
    payload = [("files", (name, content, ctype)) for name, content, ctype in files]
    return client.post(f"{API}/items/{item_id}/files", files=payload, data=data)


def stored(photos_dir):
    return sorted(p for p in photos_dir.rglob("*") if p.is_file())


def test_upload_list_and_download(client, make_item, photos_dir):
    item = make_item("Celeron")
    content = b"%PDF-1.4 manual" + b"x" * 5000
    r = upload(client, item["id"], ("Manual 300A.pdf", content, "application/pdf"), kind="manual", description="User guide")
    assert r.status_code == 201, r.text
    f = r.json()[0]
    assert f["filename"] == "Manual 300A.pdf" and f["kind"] == "manual" and f["size_bytes"] == len(content)
    assert f["description"] == "User guide"

    detail = client.get(f"{API}/items/{item['id']}").json()
    assert [x["id"] for x in detail["files"]] == [f["id"]]

    d = client.get(f["url"])
    assert d.status_code == 200 and d.content == content
    assert d.headers["content-disposition"].startswith("attachment;")
    assert "Manual%20300A.pdf" in d.headers["content-disposition"]
    assert d.headers["x-content-type-options"] == "nosniff"
    assert len(stored(photos_dir)) == 1


def test_html_is_served_as_download_only(client, make_item):
    item = make_item("x")
    f = upload(client, item["id"], ("page.html", b"<script>alert(1)</script>", "text/html")).json()[0]
    d = client.get(f["url"])
    assert d.headers["content-disposition"].startswith("attachment;")


def test_hostile_names_are_cleaned(client, make_item, photos_dir):
    item = make_item("x")
    f = upload(client, item["id"], ("../../etc/passwd", b"hello", "text/plain"), ("..\\..\\win.ini", b"hi", "text/plain")).json()
    assert [x["filename"] for x in f] == ["passwd", "win.ini"]
    for path in stored(photos_dir):
        assert path.resolve().is_relative_to(photos_dir.resolve())


def test_unicode_filename_header(client, make_item):
    item = make_item("x")
    f = upload(client, item["id"], ("Handbuch für Größe.pdf", b"abc", "application/pdf")).json()[0]
    d = client.get(f["url"])
    assert "filename*=UTF-8''Handbuch%20f%C3%BCr%20Gr%C3%B6%C3%9Fe.pdf" in d.headers["content-disposition"]
    d.headers["content-disposition"].encode("latin-1")  # must be a valid header


def test_limits_and_validation(client, make_item, photos_dir):
    item = make_item("x")
    assert upload(client, item["id"], ("e.bin", b"", "application/octet-stream")).status_code == 422
    assert upload(client, item["id"], ("big.bin", b"\0" * (3 * 1024 * 1024 + 1), "application/octet-stream")).status_code == 413
    assert upload(client, item["id"], ("a.txt", b"a", "text/plain"), kind="spaceship").status_code == 422
    assert upload(client, 99999, ("a.txt", b"a", "text/plain")).status_code == 404
    assert stored(photos_dir) == []
    assert upload(client, item["id"], ("ok.bin", b"\0" * (2 * 1024 * 1024), "application/octet-stream")).status_code == 201


def test_update_and_delete(client, make_item, photos_dir):
    item = make_item("x")
    f = upload(client, item["id"], ("a.zip", b"zip", "application/zip")).json()[0]
    r = client.patch(f"{API}/items/{item['id']}/files/{f['id']}", json={"kind": "driver", "description": "Win98 driver", "filename": "w98/driver.zip"})
    assert r.status_code == 200
    assert (r.json()["kind"], r.json()["filename"], r.json()["description"]) == ("driver", "driver.zip", "Win98 driver")
    assert client.patch(f"{API}/items/{item['id']}/files/{f['id']}", json={"kind": None}).status_code == 422
    assert client.delete(f"{API}/items/{item['id']}/files/{f['id']}").status_code == 204
    assert stored(photos_dir) == []
    assert client.get(f["url"]).status_code == 404
    assert client.delete(f"{API}/items/{item['id']}/files/{f['id']}").status_code == 404


def test_deleting_an_item_removes_its_files(client, make_item, photos_dir):
    item = make_item("x")
    upload(client, item["id"], ("a.zip", b"zip", "application/zip"), ("b.pdf", b"pdf", "application/pdf"))
    assert len(stored(photos_dir)) == 2
    assert client.delete(f"{API}/items/{item['id']}").status_code == 204
    assert stored(photos_dir) == []


def test_storage_outage_stores_nothing_and_queues_cleanup(client, make_item, db, monkeypatch):
    item = make_item("x")
    storage = build_storage("local")
    calls = {"n": 0}
    real = type(storage).put_file

    def flaky(self, key, fileobj, content_type):
        calls["n"] += 1
        if calls["n"] == 2:
            raise StorageError("boom")
        real(self, key, fileobj, content_type)

    monkeypatch.setattr(type(storage), "put_file", flaky)
    r = upload(client, item["id"], ("a.bin", b"a", "x/y"), ("b.bin", b"b", "x/y"))
    assert r.status_code == 503
    assert client.get(f"{API}/items/{item['id']}").json()["files"] == []
    assert db.query(PendingDeletion).count() == 0  # the one written object was cleaned up straight away


def test_auto_storage_picks_s3_only_when_configured(monkeypatch):
    from app.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "s3_bucket", None)
    assert build_storage("auto").name == "local"
    monkeypatch.setattr(settings, "s3_bucket", "some-bucket")
    monkeypatch.setattr(settings, "s3_endpoint_url", "http://localhost:9")
    monkeypatch.setattr(settings, "s3_access_key_id", "a")
    monkeypatch.setattr(settings, "s3_secret_access_key", "b")
    assert build_storage("auto").name == "s3"


def test_keys_are_laid_out_as_items_id_photos_and_files(client, make_item, photos_dir):
    item = make_item("x")
    f = upload(client, item["id"], ("Manual 300A.pdf", b"%PDF", "application/pdf")).json()[0]
    keys = sorted(str(p.relative_to(photos_dir)) for p in stored(photos_dir))
    assert len(keys) == 1
    assert keys[0].startswith(f"items/{item['id']}/files/") and keys[0].endswith("/Manual 300A.pdf")
    assert f["filename"] == "Manual 300A.pdf"


def test_relayout_moves_old_style_keys(client, make_item, db, photos_dir):
    import argparse

    from app import cli
    from app.models import ItemFile

    item = make_item("x")
    f = upload(client, item["id"], ("old.zip", b"zipdata", "application/zip")).json()[0]
    row = db.get(ItemFile, f["id"])
    storage = build_storage("local")
    new_key = row.storage_key
    token = "a" * 32
    old_key = f"items/{item['id']}/files/{token}"
    chunks, _ = storage.open(new_key)
    storage.put(old_key, b"".join(chunks), "x/y")
    storage.delete(new_key)
    row.storage_key = old_key
    db.commit()

    assert cli.cmd_relayout_storage(argparse.Namespace(from_prefix=None)) == 0
    db.expire_all()
    row = db.get(ItemFile, f["id"])
    assert row.storage_key == f"items/{item['id']}/files/{token[:8]}/old.zip"
    assert client.get(f["url"]).content == b"zipdata"
    assert not storage.exists(old_key)
