import pytest

API = "/api/v1"


def bulk(client, selection, changes, **extra):
    return client.post(f"{API}/items/bulk", json={"selection": selection, "changes": changes, **extra})


def item(client, item_id):
    return client.get(f"{API}/items/{item_id}").json()


def statuses(client, **params):
    page = client.get(f"{API}/items", params={"limit": 200, **params}).json()["items"]
    return {i["model"]: i["test_status"] for i in page}


def test_change_selected_items_only(client, make_item):
    a, b, c = make_item("a"), make_item("b"), make_item("c")
    r = bulk(client, {"ids": [a["id"], b["id"]]}, {"test_status": "Full Test", "condition": "Good"})
    assert r.status_code == 200 and r.json() == {"matched": 2, "moved": 0, "clashes": 0, "dry_run": False}
    assert (item(client, a["id"])["test_status"], item(client, a["id"])["condition"]) == ("Full Test", "Good")
    assert item(client, c["id"])["test_status"] == "Untested"
    assert item(client, a["id"])["updated_at"] >= a["updated_at"]


def test_filter_selection_is_stable_while_changing_its_own_field(client, make_item, cats):
    for i in range(5):
        make_item(f"cpu {i}", category="CPU")
    make_item("gpu", category="GPU/VGA")
    make_item("tested cpu", category="CPU", test_status="POST")
    r = bulk(client, {"filter": {"test_status": ["Untested"], "category_id": [cats["CPU"]]}}, {"test_status": "Dead"})
    assert r.json()["matched"] == 5
    result = statuses(client)
    assert sorted(m for m, status in result.items() if status == "Dead") == [f"cpu {i}" for i in range(5)]
    assert result["gpu"] == "Untested" and result["tested cpu"] == "POST"


def test_filter_by_search_text_and_exclusions(client, make_item):
    ids = [make_item(f"Pentium {i}", manufacturer="Intel")["id"] for i in range(4)]
    make_item("Athlon", manufacturer="AMD")
    r = bulk(client, {"filter": {"q": "intel"}, "exclude_ids": [ids[0]]}, {"condition": "Poor"})
    assert r.json()["matched"] == 3
    assert item(client, ids[0])["condition"] == "Unknown" and item(client, ids[1])["condition"] == "Poor"


def test_test_notes_set_and_clear_and_category(client, make_item, cats):
    a = make_item("a", test_notes="old")
    bulk(client, {"ids": [a["id"]]}, {"test_notes": "needs Socket 8 board"})
    assert item(client, a["id"])["test_notes"] == "needs Socket 8 board"
    bulk(client, {"ids": [a["id"]]}, {"test_notes": None})
    assert item(client, a["id"])["test_notes"] is None
    bulk(client, {"ids": [a["id"]]}, {"category_id": cats["RAM"]})
    assert item(client, a["id"])["category_name"] == "RAM"


def test_validation(client, make_item):
    a = make_item("a")
    sel = {"ids": [a["id"]]}
    assert bulk(client, sel, {}).status_code == 422
    assert bulk(client, {}, {"condition": "Good"}).status_code == 422
    assert bulk(client, {"ids": [1], "filter": {}}, {"condition": "Good"}).status_code == 422
    assert bulk(client, sel, {"condition": None}).status_code == 422
    assert bulk(client, sel, {"condition": "Mint"}).status_code == 422
    assert bulk(client, sel, {"category_id": 9999}).status_code == 422
    assert bulk(client, sel, {"location_id": 9999}).status_code == 422
    assert bulk(client, {"ids": []}, {"condition": "Good"}).json()["matched"] == 0
    assert bulk(client, {"ids": [999999]}, {"condition": "Good"}).json()["matched"] == 0


def test_dry_run_changes_nothing(client, make_item):
    a = make_item("a")
    r = bulk(client, {"ids": [a["id"]]}, {"test_status": "Dead"}, dry_run=True)
    assert r.json()["matched"] == 1 and r.json()["dry_run"] is True
    assert item(client, a["id"])["test_status"] == "Untested"


# --- moving, and what happens to positions ----------------------------------------


@pytest.fixture
def two_boxes(client, make_location, make_item):
    a, b = make_location("A"), make_location("B")
    moving = [make_item(f"m{n}", location_id=a["id"], order=n) for n in (2, 5)] + [make_item("m-none", location_id=a["id"])]
    return a, b, moving


def test_move_clears_positions_by_default(client, two_boxes):
    a, b, moving = two_boxes
    r = bulk(client, {"filter": {"location_id": a["id"], "include_descendants": False}}, {"location_id": b["id"]})
    assert r.json()["matched"] == 3 and r.json()["moved"] == 3
    for m in moving:
        got = item(client, m["id"])
        assert got["location_id"] == b["id"] and got["order"] is None


def test_move_keep_preserves_free_positions(client, two_boxes, make_item):
    a, b, moving = two_boxes
    make_item("held", location_id=b["id"], order=1)
    r = bulk(client, {"ids": [m["id"] for m in moving]}, {"location_id": b["id"]}, positions="keep")
    assert r.status_code == 200 and r.json()["moved"] == 3
    assert [item(client, m["id"])["order"] for m in moving] == [2, 5, None]


def test_move_keep_refuses_clashes_and_changes_nothing(client, two_boxes, make_item):
    a, b, moving = two_boxes
    make_item("held", location_id=b["id"], order=5)
    dry = bulk(client, {"ids": [m["id"] for m in moving]}, {"location_id": b["id"]}, positions="keep", dry_run=True)
    assert dry.status_code == 200 and dry.json()["clashes"] == 1
    r = bulk(client, {"ids": [m["id"] for m in moving]}, {"location_id": b["id"], "test_status": "Dead"}, positions="keep")
    assert r.status_code == 409 and "clash" in r.json()["detail"]
    for m in moving:  # nothing moved, nothing else changed either
        got = item(client, m["id"])
        assert got["location_id"] == two_boxes[0]["id"] and got["test_status"] == "Untested"


def test_move_keep_refuses_clashes_between_the_moving_items(client, make_location, make_item):
    a, c, dest = make_location("A"), make_location("C"), make_location("Dest")
    x = make_item("x", location_id=a["id"], order=1)
    y = make_item("y", location_id=c["id"], order=1)
    r = bulk(client, {"ids": [x["id"], y["id"]]}, {"location_id": dest["id"]}, positions="keep")
    assert r.status_code == 409


def test_move_append_continues_after_the_highest_position_in_order(client, two_boxes, make_item):
    a, b, moving = two_boxes
    for n in (1, 2, 3):
        make_item(f"held{n}", location_id=b["id"], order=n)
    r = bulk(client, {"ids": [m["id"] for m in moving]}, {"location_id": b["id"]}, positions="append")
    assert r.status_code == 200 and r.json()["moved"] == 3
    # m2 (was 2) -> 4, m5 (was 5) -> 5, unpositioned -> 6: relative order kept.
    assert [item(client, m["id"])["order"] for m in moving] == [4, 5, 6]


def test_move_append_into_an_empty_location_starts_at_one(client, two_boxes):
    a, b, moving = two_boxes
    bulk(client, {"ids": [m["id"] for m in moving]}, {"location_id": b["id"]}, positions="append")
    assert sorted(item(client, m["id"])["order"] for m in moving) == [1, 2, 3]


def test_items_already_in_the_destination_are_left_alone(client, make_location, make_item):
    a = make_location("A")
    here = make_item("here", location_id=a["id"], order=7)
    r = bulk(client, {"ids": [here["id"]]}, {"location_id": a["id"]}, positions="clear")
    assert r.json()["matched"] == 1 and r.json()["moved"] == 0
    assert item(client, here["id"])["order"] == 7


def test_unassigning_clears_location_and_position(client, two_boxes):
    a, b, moving = two_boxes
    r = bulk(client, {"ids": [moving[0]["id"]]}, {"location_id": None})
    assert r.json()["moved"] == 1
    got = item(client, moving[0]["id"])
    assert got["location_id"] is None and got["order"] is None


def test_move_everything_from_a_to_b_with_other_changes_at_once(client, two_boxes):
    a, b, moving = two_boxes
    r = bulk(
        client,
        {"filter": {"location_id": a["id"], "include_descendants": False}},
        {"location_id": b["id"], "test_status": "POST"},
        positions="append",
    )
    assert r.json()["moved"] == 3
    page = client.get(f"{API}/items", params={"location_id": b["id"], "test_status": "POST", "with_total": True}).json()
    assert page["total"] == 3
    assert client.get(f"{API}/items", params={"location_id": a["id"], "with_total": True}).json()["total"] == 0


def test_a_large_selection_is_applied_in_one_go(client, db):
    from sqlalchemy import text

    db.execute(text("INSERT INTO items (category_id, model) SELECT (SELECT min(id) FROM categories), 'bulk ' || g FROM generate_series(1, 20000) g"))
    db.commit()
    r = bulk(client, {"filter": {"test_status": ["Untested"]}}, {"test_status": "Dead"})
    assert r.status_code == 200 and r.json()["matched"] == 20000
    assert client.get(f"{API}/items", params={"test_status": "Dead", "with_total": True, "limit": 1}).json()["total"] == 20000
