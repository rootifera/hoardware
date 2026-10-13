import io

from PIL import Image

from app.models import PendingDeletion
from app.storage import get_storage
from app.storage.base import StorageError

API = "/api/v1"


def image_bytes(fmt="JPEG", size=(800, 600), color="red"):
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format=fmt)
    return buffer.getvalue()


def upload(client, item_id, *files, **data):
    payload = [("files", (name, content, ctype)) for name, content, ctype in files]
    return client.post(f"{API}/items/{item_id}/photos", files=payload, data=data)


def stored_files(photos_dir):
    return sorted(p for p in photos_dir.rglob("*") if p.is_file())


def test_upload_multiple_photos_with_thumbnails(client, make_item, photos_dir):
    item = make_item("card")
    r = upload(client, item["id"], ("front.jpg", image_bytes(), "image/jpeg"), ("back.png", image_bytes("PNG"), "image/png"), role="front")
    assert r.status_code == 201, r.text
    photos = r.json()
    assert [p["content_type"] for p in photos] == ["image/jpeg", "image/png"]
    assert [p["sort_order"] for p in photos] == [0, 1]
    assert all(p["role"] == "front" for p in photos)
    assert len(stored_files(photos_dir)) == 4  # two originals, two thumbnails

    detail = client.get(f"{API}/items/{item['id']}").json()
    assert [p["id"] for p in detail["photos"]] == [p["id"] for p in photos]
    assert detail["thumbnail_url"] == photos[0]["thumbnail_url"]

    thumb = client.get(photos[0]["thumbnail_url"])
    assert thumb.status_code == 200 and thumb.headers["content-type"] == "image/webp"
    with Image.open(io.BytesIO(thumb.content)) as im:
        assert max(im.size) <= 480
    original = client.get(photos[0]["url"])
    assert original.content == image_bytes() or original.headers["content-type"] == "image/jpeg"
    assert "immutable" in original.headers["cache-control"]
    assert client.get(photos[0]["url"], headers={"If-None-Match": original.headers["etag"]}).status_code == 304


def test_list_endpoint_exposes_only_thumbnail(client, make_item):
    item = make_item("card")
    other = make_item("no photo")
    photo = upload(client, item["id"], ("a.jpg", image_bytes(), "image/jpeg")).json()[0]
    items = {i["id"]: i for i in client.get(f"{API}/items").json()["items"]}
    assert items[item["id"]]["thumbnail_url"] == photo["thumbnail_url"]
    assert items[other["id"]]["thumbnail_url"] is None


def test_rejects_non_images_even_with_image_content_type(client, make_item, photos_dir):
    item = make_item("card")
    r = upload(client, item["id"], ("evil.jpg", b"<html>not an image</html>", "image/jpeg"))
    assert r.status_code == 415
    r = upload(client, item["id"], ("notes.txt", b"hello", "text/plain"))
    assert r.status_code == 415
    assert stored_files(photos_dir) == []


def test_rejects_unsupported_image_formats(client, make_item):
    item = make_item("card")
    assert upload(client, item["id"], ("a.bmp", image_bytes("BMP", size=(100, 100)), "image/bmp")).status_code == 415


def test_rejects_empty_and_oversized_files(client, make_item, photos_dir):
    item = make_item("card")
    assert upload(client, item["id"], ("e.jpg", b"", "image/jpeg")).status_code == 422
    big = image_bytes(size=(1600, 1600)) + b"\0" * (1024 * 1024)
    assert upload(client, item["id"], ("big.jpg", big, "image/jpeg")).status_code == 413
    assert stored_files(photos_dir) == []


def test_one_bad_file_stores_nothing(client, make_item, photos_dir):
    item = make_item("card")
    r = upload(client, item["id"], ("ok.jpg", image_bytes(), "image/jpeg"), ("bad.jpg", b"nope", "image/jpeg"))
    assert r.status_code == 415
    assert stored_files(photos_dir) == []
    assert client.get(f"{API}/items/{item['id']}").json()["photos"] == []


def test_hostile_filenames_cannot_escape_storage(client, make_item, photos_dir):
    item = make_item("card")
    r = upload(client, item["id"], ("../../../../etc/passwd.jpg", image_bytes(), "image/jpeg"))
    assert r.status_code == 201
    for path in stored_files(photos_dir):
        assert path.resolve().is_relative_to(photos_dir.resolve())
        assert ".." not in path.name and "passwd" not in str(path)


def test_upload_to_missing_item(client):
    assert upload(client, 12345, ("a.jpg", image_bytes(), "image/jpeg")).status_code == 404


def test_update_and_delete_photo_removes_files(client, make_item, photos_dir):
    item = make_item("card")
    photo = upload(client, item["id"], ("a.jpg", image_bytes(), "image/jpeg")).json()[0]
    r = client.patch(f"{API}/items/{item['id']}/photos/{photo['id']}", json={"role": "label", "caption": "P/N sticker"})
    assert r.json()["role"] == "label" and r.json()["caption"] == "P/N sticker"
    assert client.patch(f"{API}/items/{item['id']}/photos/{photo['id']}", json={"role": "sideways"}).status_code == 422

    assert client.delete(f"{API}/items/{item['id']}/photos/{photo['id']}").status_code == 204
    assert stored_files(photos_dir) == []
    assert client.get(photo["url"]).status_code == 404
    assert client.delete(f"{API}/items/{item['id']}/photos/{photo['id']}").status_code == 404


def test_photo_must_belong_to_item(client, make_item):
    one, two = make_item("one"), make_item("two")
    photo = upload(client, one["id"], ("a.jpg", image_bytes(), "image/jpeg")).json()[0]
    assert client.delete(f"{API}/items/{two['id']}/photos/{photo['id']}").status_code == 404
    assert client.patch(f"{API}/items/{two['id']}/photos/{photo['id']}", json={"caption": "x"}).status_code == 404


def test_deleting_item_removes_its_photos(client, make_item, photos_dir):
    item = make_item("card")
    upload(client, item["id"], ("a.jpg", image_bytes(), "image/jpeg"), ("b.jpg", image_bytes(), "image/jpeg"))
    assert len(stored_files(photos_dir)) == 4
    assert client.delete(f"{API}/items/{item['id']}").status_code == 204
    assert stored_files(photos_dir) == []


def test_failed_storage_delete_is_queued_and_retried(client, make_item, photos_dir, db, monkeypatch):
    item = make_item("card")
    upload(client, item["id"], ("a.jpg", image_bytes(), "image/jpeg"))
    storage = get_storage()
    real_delete = storage.delete

    def broken(key):
        raise StorageError("storage down")

    monkeypatch.setattr(storage, "delete", broken)
    assert client.delete(f"{API}/items/{item['id']}").status_code == 204
    assert len(stored_files(photos_dir)) == 2  # still on disk...
    assert db.query(PendingDeletion).count() == 2  # ...but not forgotten

    monkeypatch.setattr(storage, "delete", real_delete)
    from app.services.photos import process_pending_deletions

    assert process_pending_deletions(db, storage) == (2, 0)
    assert stored_files(photos_dir) == []
    assert db.query(PendingDeletion).count() == 0


def test_failed_upload_leaves_no_orphans(client, make_item, photos_dir, monkeypatch):
    item = make_item("card")
    storage = get_storage()
    real_put = storage.put
    calls = {"n": 0}

    def flaky(key, data, content_type):
        calls["n"] += 1
        if calls["n"] == 3:
            raise StorageError("disk full")
        real_put(key, data, content_type)

    monkeypatch.setattr(storage, "put", flaky)
    r = upload(client, item["id"], ("a.jpg", image_bytes(), "image/jpeg"), ("b.jpg", image_bytes(), "image/jpeg"))
    assert r.status_code == 503
    assert stored_files(photos_dir) == []
    assert client.get(f"{API}/items/{item['id']}").json()["photos"] == []
