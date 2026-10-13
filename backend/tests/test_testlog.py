from datetime import date, timedelta

API = "/api/v1"


def log(client, item_id):
    r = client.get(f"{API}/items/{item_id}/test-log")
    assert r.status_code == 200, r.text
    return r.json()


def test_a_new_untested_item_has_no_history(client, make_item):
    item = make_item("a")
    assert log(client, item["id"]) == []
    assert client.get(f"{API}/items/{item['id']}").json()["last_tested_on"] is None


def test_creating_an_item_with_a_known_status_starts_its_history(client, make_item):
    item = make_item("a", test_status="POST", test_notes="boots to BIOS")
    (entry,) = log(client, item["id"])
    assert (entry["status"], entry["notes"], entry["tested_on"]) == ("POST", "boots to BIOS", date.today().isoformat())
    assert client.get(f"{API}/items/{item['id']}").json()["last_tested_on"] == date.today().isoformat()


def test_changing_the_status_is_logged_but_other_edits_are_not(client, make_item):
    item = make_item("a")
    client.patch(f"{API}/items/{item['id']}", json={"notes": "x", "condition": "Good"})
    assert log(client, item["id"]) == []
    client.patch(f"{API}/items/{item['id']}", json={"test_status": "Full Test", "test_notes": "ran 3DMark"})
    client.patch(f"{API}/items/{item['id']}", json={"test_status": "Full Test"})  # unchanged: no new entry
    client.patch(f"{API}/items/{item['id']}", json={"test_status": "Dead"})
    entries = log(client, item["id"])
    assert [e["status"] for e in entries] == ["Dead", "Full Test"]  # newest first
    assert entries[1]["notes"] == "ran 3DMark" and entries[0]["notes"] == "ran 3DMark"  # snapshot of the notes at the time


def test_logging_a_test_by_hand_updates_the_item(client, make_item):
    item = make_item("a")
    when = (date.today() - timedelta(days=30)).isoformat()
    r = client.post(f"{API}/items/{item['id']}/test-log", json={"status": "Full Test", "tested_on": when, "notes": "Voodoo2 in SLI"})
    assert r.status_code == 201 and r.json()["tested_on"] == when
    detail = client.get(f"{API}/items/{item['id']}").json()
    assert (detail["test_status"], detail["test_notes"], detail["last_tested_on"]) == ("Full Test", "Voodoo2 in SLI", when)
    # Without notes the item's current notes stay.
    client.post(f"{API}/items/{item['id']}/test-log", json={"status": "POST"})
    detail = client.get(f"{API}/items/{item['id']}").json()
    assert detail["test_status"] == "POST" and detail["test_notes"] == "Voodoo2 in SLI"
    assert [e["status"] for e in log(client, item["id"])] == ["POST", "Full Test"]  # today's entry sorts above the older one


def test_history_is_ordered_by_test_date_then_entry(client, make_item):
    item = make_item("a")
    for days, status in [(5, "POST"), (1, "Full Test"), (9, "Unknown")]:
        client.post(f"{API}/items/{item['id']}/test-log", json={"status": status, "tested_on": (date.today() - timedelta(days=days)).isoformat()})
    assert [e["status"] for e in log(client, item["id"])] == ["Full Test", "POST", "Unknown"]


def test_removing_a_mistaken_entry_leaves_the_current_status(client, make_item):
    item = make_item("a")
    entry = client.post(f"{API}/items/{item['id']}/test-log", json={"status": "Dead"}).json()
    assert client.delete(f"{API}/items/{item['id']}/test-log/{entry['id']}").status_code == 204
    assert log(client, item["id"]) == []
    assert client.get(f"{API}/items/{item['id']}").json()["test_status"] == "Dead"
    assert client.delete(f"{API}/items/{item['id']}/test-log/{entry['id']}").status_code == 404
    other = make_item("b")
    entry = client.post(f"{API}/items/{item['id']}/test-log", json={"status": "POST"}).json()
    assert client.delete(f"{API}/items/{other['id']}/test-log/{entry['id']}").status_code == 404


def test_validation_and_missing_items(client, make_item):
    item = make_item("a")
    assert client.post(f"{API}/items/{item['id']}/test-log", json={"status": "Works"}).status_code == 422
    assert client.post(f"{API}/items/{item['id']}/test-log", json={"status": "POST", "tested_on": "yesterday"}).status_code == 422
    assert client.post(f"{API}/items/999/test-log", json={"status": "POST"}).status_code == 404
    assert client.get(f"{API}/items/999/test-log").status_code == 404


def test_bulk_status_changes_log_only_items_that_change(client, make_item):
    a, b, c = make_item("a"), make_item("b", test_status="Dead"), make_item("c")
    client.post(f"{API}/items/bulk", json={"selection": {"ids": [a["id"], b["id"], c["id"]]}, "changes": {"test_status": "Dead"}})
    assert [e["status"] for e in log(client, a["id"])] == ["Dead"]
    assert [e["status"] for e in log(client, b["id"])] == ["Dead"]  # b's creation entry only; unchanged by the bulk
    assert len(log(client, c["id"])) == 1


def test_bulk_log_records_the_notes_in_force(client, make_item):
    a, b = make_item("a", test_notes="old note"), make_item("b")
    client.post(f"{API}/items/bulk", json={"selection": {"ids": [a["id"], b["id"]]}, "changes": {"test_status": "Unknown"}})
    assert log(client, a["id"])[0]["notes"] == "old note" and log(client, b["id"])[0]["notes"] is None
    client.post(f"{API}/items/bulk", json={"selection": {"ids": [a["id"]]}, "changes": {"test_status": "POST", "test_notes": "new note"}})
    assert log(client, a["id"])[0]["notes"] == "new note"


def test_bulk_dry_run_logs_nothing_and_other_bulk_changes_do_not_log(client, make_item):
    a = make_item("a")
    client.post(f"{API}/items/bulk", json={"selection": {"ids": [a["id"]]}, "changes": {"test_status": "Dead"}, "dry_run": True})
    client.post(f"{API}/items/bulk", json={"selection": {"ids": [a["id"]]}, "changes": {"condition": "Poor"}})
    assert log(client, a["id"]) == []


def test_batch_copies_with_a_known_status_each_get_an_entry(client, cats, db):
    r = client.post(f"{API}/items/batch", json={"item": {"category_id": cats["CPU"], "model": "x", "test_status": "POST"}, "copies": 3})
    ids = [c["id"] for c in r.json()["created"]]
    assert all(len(log(client, i)) == 1 for i in ids)


def test_deleting_an_item_removes_its_history(client, make_item, db):
    from app.models import TestLog

    item = make_item("a", test_status="Dead")
    client.delete(f"{API}/items/{item['id']}")
    assert db.query(TestLog).count() == 0
