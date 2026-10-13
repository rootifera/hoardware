from datetime import date, timedelta

API = "/api/v1"
TODAY = date.today()


def day(n):
    return (TODAY - timedelta(days=n)).isoformat()


def models(client, **params):
    page = client.get(f"{API}/items", params={"limit": 200, "sort": "name", **params}).json()
    return [i["model"] for i in page["items"]]


def test_verified_on_is_optional_and_editable(client, make_item):
    item = make_item("a")
    assert item["verified_on"] is None
    r = client.patch(f"{API}/items/{item['id']}", json={"verified_on": day(3)})
    assert r.json()["verified_on"] == day(3)
    assert client.patch(f"{API}/items/{item['id']}", json={"verified_on": None}).json()["verified_on"] is None
    assert client.patch(f"{API}/items/{item['id']}", json={"verified_on": "last week"}).status_code == 422
    assert make_item("b", verified_on=day(1))["verified_on"] == day(1)


def test_filtering_by_when_items_were_last_seen(client, make_item):
    make_item("never")
    make_item("long ago", verified_on=day(200))
    make_item("lately", verified_on=day(5))
    make_item("today", verified_on=day(0))
    assert models(client, never_verified=True) == ["never"]
    assert models(client, verified_before=day(90)) == ["long ago", "never"]  # never counts as not seen lately
    assert models(client, verified_before=day(1)) == ["lately", "long ago", "never"]
    assert models(client, verified_before=day(300)) == ["never"]
    assert models(client) == ["lately", "long ago", "never", "today"]


def test_the_status_strip_counts_follow_the_verified_filter(client, make_item):
    make_item("a", test_status="Dead", verified_on=day(0))
    make_item("b", test_status="Dead")
    assert client.get(f"{API}/items/facets", params={"never_verified": True}).json()["Dead"] == 1


def bulk(client, selection, changes, **extra):
    return client.post(f"{API}/items/bulk", json={"selection": selection, "changes": changes, **extra})


def test_bulk_mark_verified_and_clear(client, make_item):
    a, b, c = make_item("a"), make_item("b", verified_on=day(40)), make_item("c")
    r = bulk(client, {"ids": [a["id"], b["id"]]}, {"verified": True})
    assert r.status_code == 200 and r.json()["matched"] == 2
    assert client.get(f"{API}/items/{a['id']}").json()["verified_on"] == TODAY.isoformat()
    assert client.get(f"{API}/items/{b['id']}").json()["verified_on"] == TODAY.isoformat()
    assert client.get(f"{API}/items/{c['id']}").json()["verified_on"] is None
    bulk(client, {"ids": [a["id"]]}, {"verified": False})
    assert client.get(f"{API}/items/{a['id']}").json()["verified_on"] is None
    assert bulk(client, {"ids": [a["id"]]}, {"verified": None}).status_code == 422


def test_stock_take_flow_find_what_was_not_seen(client, make_item, make_location):
    box = make_location("Box")
    seen = [make_item(f"seen {i}", location_id=box["id"], order=i) for i in (1, 2)]
    make_item("missing", location_id=box["id"], order=3)
    bulk(client, {"ids": [i["id"] for i in seen]}, {"verified": True})
    # Everything in the box not verified today:
    assert models(client, location_id=box["id"], verified_before=TODAY.isoformat()) == ["missing"]


def test_bulk_filter_selection_can_use_the_verified_filter(client, make_item):
    make_item("old", verified_on=day(100))
    make_item("new", verified_on=day(1))
    r = bulk(client, {"filter": {"verified_before": day(30)}}, {"test_status": "POST"})
    assert r.json()["matched"] == 1


def test_export_and_import_carry_verified_on(client, make_item):
    make_item("a", verified_on=day(7))
    exported = client.get(f"{API}/export/items.csv").content
    assert b"verified_on" in exported.splitlines()[0]
    for item in client.get(f"{API}/items").json()["items"]:
        client.delete(f"{API}/items/{item['id']}")
    r = client.post(f"{API}/import/items.csv", params={"commit": True}, files={"file": ("x.csv", exported, "text/csv")})
    assert r.json()["imported"] == 1
    got = client.get(f"{API}/items").json()["items"][0]
    assert client.get(f"{API}/items/{got['id']}").json()["verified_on"] == day(7)
    bad = client.post(f"{API}/import/items.csv", files={"file": ("x.csv", b"category,model,verified\nCPU,x,soon\n", "text/csv")})
    assert bad.json()["error_rows"] == 1 and "verified_on" in bad.json()["errors"][0]["message"]
