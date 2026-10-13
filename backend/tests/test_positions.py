import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

API = "/api/v1"


def models(client, **params):
    r = client.get(f"{API}/items", params={"limit": 200, **params})
    assert r.status_code == 200, r.text
    return [i["model"] for i in r.json()["items"]]


def test_an_item_has_an_exact_position_in_its_location(client, make_item, make_location):
    box = make_location("CPU Box")
    item = make_item("Pentium", location_id=box["id"], order=4)
    assert item["order"] == 4 and item["location_path"] == "CPU Box"
    assert client.get(f"{API}/items", params={"location_id": box["id"]}).json()["items"][0]["order"] == 4


def test_two_items_cannot_share_the_same_exact_location(client, make_item, make_location, cats):
    box = make_location("CPU Box")
    first = make_item("a", location_id=box["id"], order=3)
    r = client.post(f"{API}/items", json={"category_id": cats["CPU"], "model": "b", "location_id": box["id"], "order": 3})
    assert r.status_code == 409
    assert "CPU Box position 3" in r.json()["detail"] and first["inventory_code"] in r.json()["detail"]

    other = make_item("c", location_id=box["id"], order=4)
    r = client.patch(f"{API}/items/{other['id']}", json={"order": 3})
    assert r.status_code == 409
    assert client.get(f"{API}/items/{other['id']}").json()["order"] == 4  # unchanged


def test_same_position_in_different_locations_and_unpositioned_items_are_fine(client, make_item, make_location):
    a, b = make_location("A"), make_location("B")
    make_item("a1", location_id=a["id"], order=1)
    make_item("b1", location_id=b["id"], order=1)
    for name in ("x", "y", "z"):  # no position: can share a location freely
        make_item(name, location_id=a["id"])


def test_resaving_an_item_keeps_its_own_position(client, make_item, make_location):
    box = make_location("Box")
    item = make_item("a", location_id=box["id"], order=2)
    assert client.patch(f"{API}/items/{item['id']}", json={"notes": "hello"}).status_code == 200
    assert client.patch(f"{API}/items/{item['id']}", json={"location_id": box["id"], "order": 2}).status_code == 200


def test_a_position_needs_a_location(client, make_item, cats, make_location):
    r = client.post(f"{API}/items", json={"category_id": cats["CPU"], "model": "x", "order": 1})
    assert r.status_code == 422 and "location" in r.json()["detail"]
    item = make_item("y")
    assert client.patch(f"{API}/items/{item['id']}", json={"order": 1}).status_code == 422


def test_position_must_be_a_sane_number(client, cats, make_location):
    box = make_location("Box")
    base = {"category_id": cats["CPU"], "model": "x", "location_id": box["id"]}
    assert client.post(f"{API}/items", json={**base, "order": -1}).status_code == 422
    assert client.post(f"{API}/items", json={**base, "order": 2_000_000}).status_code == 422
    assert client.post(f"{API}/items", json={**base, "order": 0}).status_code == 201


def test_moving_an_item_clears_its_old_position_unless_a_new_one_is_given(client, make_item, make_location):
    a, b = make_location("A"), make_location("B")
    item = make_item("a", location_id=a["id"], order=5)
    moved = client.patch(f"{API}/items/{item['id']}", json={"location_id": b["id"]}).json()
    assert moved["location_id"] == b["id"] and moved["order"] is None

    placed = client.patch(f"{API}/items/{item['id']}", json={"location_id": a["id"], "order": 5}).json()
    assert placed["order"] == 5
    removed = client.patch(f"{API}/items/{item['id']}", json={"location_id": None}).json()
    assert removed["location_id"] is None and removed["order"] is None
    assert client.patch(f"{API}/items/{item['id']}", json={"location_id": None, "order": 3}).status_code == 422


def test_moving_into_a_taken_position_is_refused(client, make_item, make_location):
    a, b = make_location("A"), make_location("B")
    make_item("held", location_id=b["id"], order=1)
    item = make_item("mover", location_id=a["id"], order=1)
    assert client.patch(f"{API}/items/{item['id']}", json={"location_id": b["id"], "order": 1}).status_code == 409
    assert client.patch(f"{API}/items/{item['id']}", json={"location_id": b["id"], "order": 2}).status_code == 200


def test_deleting_an_item_frees_its_position(client, make_item, make_location):
    box = make_location("Box")
    item = make_item("a", location_id=box["id"], order=1)
    client.delete(f"{API}/items/{item['id']}")
    make_item("b", location_id=box["id"], order=1)


def test_the_database_itself_refuses_duplicates_and_orphan_positions(client, make_item, make_location, db):
    box = make_location("Box")
    item = make_item("a", location_id=box["id"], order=1)
    with pytest.raises(IntegrityError, match="uq_items_location_order"):
        db.execute(text('INSERT INTO items (category_id, model, location_id, "order") VALUES (:c, \'raw\', :l, 1)'), {"c": item["category_id"], "l": box["id"]})
    db.rollback()
    with pytest.raises(IntegrityError, match="ck_items_order_needs_location"):
        db.execute(text('INSERT INTO items (category_id, model, "order") VALUES (:c, \'raw\', 1)'), {"c": item["category_id"]})
    db.rollback()


def test_next_position(client, make_item, make_location):
    box = make_location("Box")
    assert client.get(f"{API}/locations/{box['id']}/next-position").json() == 1
    for order in (1, 2, 5):
        make_item(f"p{order}", location_id=box["id"], order=order)
    assert client.get(f"{API}/locations/{box['id']}/next-position").json() == 6
    assert client.get(f"{API}/locations/9999/next-position").status_code == 404


def test_sorting_a_location_by_position_puts_unpositioned_items_last(client, make_item, make_location):
    box = make_location("Box")
    for name, order in [("three", 3), ("one", 1), ("none-b", None), ("two", 2), ("none-a", None)]:
        make_item(name, location_id=box["id"], **({"order": order} if order is not None else {}))
    assert models(client, location_id=box["id"], sort="position") == ["one", "two", "three", "none-a", "none-b"]
    assert models(client, location_id=box["id"], sort="position", order="desc") == ["none-b", "none-a", "three", "two", "one"]

    seen, cursor = [], None
    while True:
        params = {"location_id": box["id"], "sort": "position", "limit": 2, **({"cursor": cursor} if cursor else {})}
        page = client.get(f"{API}/items", params=params).json()
        seen += [i["model"] for i in page["items"]]
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert seen == ["one", "two", "three", "none-a", "none-b"]


def test_location_types(client, make_location):
    shelf = make_location("Shelf", type="shelf")
    box = make_location("Box", shelf["id"], type="  box ")
    assert shelf["type"] == "shelf" and box["type"] == "box"
    assert client.get(f"{API}/locations/{box['id']}").json()["type"] == "box"
    assert client.patch(f"{API}/locations/{box['id']}", json={"type": "drawer"}).json()["type"] == "drawer"
    assert client.patch(f"{API}/locations/{box['id']}", json={"type": ""}).json()["type"] is None
    make_location("Other", type="Shelf")
    make_location("Plain")
    assert sorted(client.get(f"{API}/locations/types").json()) == ["Shelf", "shelf"]
    kids = client.get(f"{API}/locations", params={"parent_id": shelf["id"]}).json()["items"]
    assert kids[0]["type"] is None
    assert len(client.get(f"{API}/locations/types").json()) == 2


def batch(client, cats, copies, **extra):
    item = {"category_id": cats["CPU"], "model": "Pentium MMX 200", "manufacturer": "Intel", **extra.pop("item", {})}
    return client.post(f"{API}/items/batch", json={"item": item, "copies": copies, **extra})


def test_ten_identical_cpus_at_positions_one_to_ten(client, cats, make_location):
    box = make_location("CPU Box")
    r = batch(client, cats, 10, order_start=1, item={"location_id": box["id"], "condition": "Good", "test_status": "POST"})
    assert r.status_code == 201, r.text
    created = r.json()["created"]
    assert [c["order"] for c in created] == list(range(1, 11))
    assert len({c["id"] for c in created}) == 10 and len({c["inventory_code"] for c in created}) == 10
    assert {c["location_path"] for c in created} == {"CPU Box"}
    assert models(client, location_id=box["id"], sort="position") == ["Pentium MMX 200"] * 10

    # Separate records afterwards.
    client.patch(f"{API}/items/{created[0]['id']}", json={"test_status": "Dead"})
    assert client.get(f"{API}/items/{created[1]['id']}").json()["test_status"] == "POST"
    # The spots are now taken.
    assert batch(client, cats, 1, order_start=10, item={"location_id": box["id"]}).status_code == 409


def test_batch_that_collides_creates_nothing(client, cats, make_location, make_item):
    box = make_location("Box")
    holder = make_item("holder", location_id=box["id"], order=3)
    r = batch(client, cats, 5, order_start=1, item={"location_id": box["id"]})
    assert r.status_code == 409 and "position 3" in r.json()["detail"] and holder["inventory_code"] in r.json()["detail"]
    assert models(client) == ["holder"]


def test_batch_without_positions_and_validation(client, cats, make_location):
    box = make_location("Box")
    created = batch(client, cats, 3, item={"location_id": box["id"]}).json()["created"]
    assert [c["order"] for c in created] == [None, None, None]
    assert batch(client, cats, 2).json()["created"][0]["location_path"] is None
    assert batch(client, cats, 2, order_start=1).status_code == 422  # positions need a location
    assert batch(client, cats, 2, order_start=1, item={"location_id": box["id"], "order": 1}).status_code == 422
    assert batch(client, cats, 0).status_code == 422
    assert batch(client, cats, 201).status_code == 422
    assert batch(client, cats, 1, item={"location_id": 9999}).status_code == 422
    assert client.post(f"{API}/items/batch", json={"item": {"category_id": 9999, "model": "x"}, "copies": 1}).status_code == 422


def test_csv_export_includes_the_position(client, make_item, make_location):
    box = make_location("Box")
    make_item("a", location_id=box["id"], order=7)
    make_item("b")
    text_ = client.get(f"{API}/export/items.csv").text.splitlines()
    header = text_[0].split(",")
    assert "position" in header
    col = header.index("position")
    assert [line.split(",")[col] for line in text_[1:]] == ["7", ""]
