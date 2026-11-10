API = "/api/v1"


def listed(client, **params):
    r = client.get(f"{API}/items", params={"limit": 200, **params})
    assert r.status_code == 200, r.text
    return {i["model"] for i in r.json()["items"]}


def history(client, item_id):
    return client.get(f"{API}/items/{item_id}/history").json()


def test_new_items_are_in_the_collection(make_item):
    item = make_item("Pentium")
    assert item["status"] == "in_collection" and item["installed_in"] is None and item["parts"] == []


def test_sold_scrapped_and_wanted_items_leave_the_default_list_but_keep_their_record(client, make_item, make_location):
    box = make_location("Box 1")
    keep = make_item("Keeper", location_id=box["id"])
    sold = make_item("Sold one", location_id=box["id"], order=3)
    wish = make_item("Wishlist one", status="wanted")
    assert listed(client) == {"Keeper", "Sold one", "Wishlist one"} - {"Wishlist one"}
    r = client.patch(f"{API}/items/{sold['id']}", json={"status": "sold", "status_note": "eBay"})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "sold" and body["status_note"] == "eBay"
    assert body["location_id"] is None and body["order"] is None  # off the shelf
    assert listed(client) == {"Keeper"}
    assert listed(client, status="sold") == {"Sold one"}
    assert listed(client, status="wanted") == {"Wishlist one"}
    assert listed(client, status=["sold", "wanted", "in_collection"]) == {"Keeper", "Sold one", "Wishlist one"}
    # its position is free again
    again = make_item("Reuses the spot", location_id=box["id"], order=3)
    assert again["order"] == 3
    # moving back clears the old note
    back = client.patch(f"{API}/items/{sold['id']}", json={"status": "in_collection"}).json()
    assert back["status_note"] is None
    assert wish["status"] == "wanted" and keep["status"] == "in_collection"


def test_history_records_moves_and_status_changes(client, make_item, make_location):
    a, b = make_location("Shelf A"), make_location("Shelf B")
    item = make_item("Travels", location_id=a["id"])
    client.patch(f"{API}/items/{item['id']}", json={"location_id": b["id"]})
    client.patch(f"{API}/items/{item['id']}", json={"status": "lent", "status_note": "Sam"})
    client.patch(f"{API}/items/{item['id']}", json={"notes": "nothing relevant"})
    log = history(client, item["id"])
    assert [(e["kind"], e["old"], e["new"]) for e in log] == [
        ("status", "in_collection", "lent"),
        ("location", "Shelf A", "Shelf B"),
    ]
    # a deleted location still reads properly in the history
    client.patch(f"{API}/items/{item['id']}", json={"location_id": None})
    client.delete(f"{API}/locations/{a['id']}")
    assert history(client, item["id"])[0]["new"] is None
    assert any(e["old"] == "Shelf A" for e in history(client, item["id"]))
    assert client.get(f"{API}/items/99999/history").status_code == 404


def test_installing_parts_in_a_build(client, make_item, make_location):
    build = make_item("Retro 486 PC", category="Other")
    cpu = make_item("486DX2")
    r = client.patch(f"{API}/items/{cpu['id']}", json={"installed_in_id": build["id"]}).json()
    assert r["status"] == "installed" and r["installed_in"]["id"] == build["id"]
    parts = client.get(f"{API}/items/{build['id']}").json()["parts"]
    assert [p["id"] for p in parts] == [cpu["id"]]
    log = history(client, cpu["id"])
    assert {e["kind"] for e in log} == {"status", "installed_in"}
    # taking it out returns it to the collection
    out = client.patch(f"{API}/items/{cpu['id']}", json={"installed_in_id": None}).json()
    assert out["status"] == "in_collection" and out["installed_in"] is None
    # lending a part takes it out of the build
    client.patch(f"{API}/items/{cpu['id']}", json={"installed_in_id": build["id"]})
    lent = client.patch(f"{API}/items/{cpu['id']}", json={"status": "lent"}).json()
    assert lent["installed_in_id"] is None


def test_build_rules(client, make_item):
    a, b = make_item("Case A", category="Other"), make_item("Part B")
    assert client.patch(f"{API}/items/{a['id']}", json={"installed_in_id": a["id"]}).status_code == 422
    assert client.patch(f"{API}/items/{a['id']}", json={"installed_in_id": 99999}).status_code == 422
    client.patch(f"{API}/items/{b['id']}", json={"installed_in_id": a["id"]})
    cycle = client.patch(f"{API}/items/{a['id']}", json={"installed_in_id": b["id"]})
    assert cycle.status_code == 422 and "own parts" in cycle.json()["detail"]
    # created already installed
    c = make_item("Part C", installed_in_id=a["id"])
    assert c["status"] == "installed"


def test_deleting_a_build_returns_its_parts(client, make_item):
    build = make_item("Doomed PC", category="Other")
    part = make_item("Survivor", installed_in_id=build["id"])
    assert client.delete(f"{API}/items/{build['id']}").status_code == 204
    after = client.get(f"{API}/items/{part['id']}").json()
    assert after["status"] == "in_collection" and after["installed_in_id"] is None
    assert any(e["new"] == "in_collection" for e in history(client, part["id"]))


def test_price_and_source(client, make_item):
    item = make_item("Bought", price=12.5, source="Car boot sale")
    assert item["price"] == 12.5 and item["source"] == "Car boot sale"
    assert client.patch(f"{API}/items/{item['id']}", json={"price": None}).json()["price"] is None
    assert client.post(f"{API}/items", json={"category_id": item["category_id"], "model": "x", "price": -1}).status_code == 422


def test_bulk_status_and_history(client, make_item, make_location):
    box = make_location("Bulk box")
    ids = [make_item(f"Bulk {n}", location_id=box["id"])["id"] for n in range(3)]
    r = client.post(f"{API}/items/bulk", json={"selection": {"ids": ids}, "changes": {"status": "sold", "status_note": "job lot"}})
    assert r.status_code == 200 and r.json()["moved"] == 3
    for item_id in ids:
        item = client.get(f"{API}/items/{item_id}").json()
        assert item["status"] == "sold" and item["location_id"] is None and item["status_note"] == "job lot"
        assert {e["kind"] for e in history(client, item_id)} == {"status", "location"}
    assert client.post(f"{API}/items/bulk", json={"selection": {"ids": ids}, "changes": {"status": "installed"}}).status_code == 422


def test_bulk_move_is_recorded(client, make_item, make_location):
    a, b = make_location("From"), make_location("To")
    item = make_item("Moved in bulk", location_id=a["id"])
    client.post(f"{API}/items/bulk", json={"selection": {"ids": [item["id"]]}, "changes": {"location_id": b["id"]}})
    assert [(e["old"], e["new"]) for e in history(client, item["id"])] == [("From", "To")]


def test_bulk_set_and_remove_specs(client, make_item):
    one = make_item("One", attributes={"Socket": "7", "Keep": "x"})
    two = make_item("Two")
    r = client.post(
        f"{API}/items/bulk",
        json={"selection": {"ids": [one["id"], two["id"]]}, "changes": {"attributes": {"Socket": "Socket 7", "Keep": None, "Year": 1997}}},
    )
    assert r.status_code == 200
    for item in (one, two):
        attrs = client.get(f"{API}/items/{item['id']}").json()["attributes"]
        assert attrs["Socket"] == "Socket 7" and attrs["Year"] == 1997 and "Keep" not in attrs


def test_split_stock_across_locations(client, make_item, make_location):
    a, b = make_location("Drawer A"), make_location("Drawer B")
    item = make_item("100nF cap", is_stock=True, quantity=100, location_id=a["id"], low_stock_level=5)
    r = client.post(f"{API}/items/{item['id']}/split", json={"quantity": 30, "location_id": b["id"]})
    assert r.status_code == 201
    new = r.json()
    assert new["quantity"] == 30 and new["location_id"] == b["id"] and new["is_stock"] and new["low_stock_level"] == 5
    assert new["id"] != item["id"] and new["inventory_code"] != item["inventory_code"]
    assert client.get(f"{API}/items/{item['id']}").json()["quantity"] == 70
    log = client.get(f"{API}/items/{item['id']}/stock-log").json()
    assert log[0]["change"] == -30 and new["inventory_code"] in log[0]["note"]
    assert client.get(f"{API}/items/{new['id']}/stock-log").json()[-1]["note"].startswith("Split from")
    # refused cases
    assert client.post(f"{API}/items/{item['id']}/split", json={"quantity": 70, "location_id": b["id"]}).status_code == 409
    assert client.post(f"{API}/items/{item['id']}/split", json={"quantity": 1, "location_id": a["id"]}).status_code == 422
    single = make_item("Not stock")
    assert client.post(f"{API}/items/{single['id']}/split", json={"quantity": 1, "location_id": b["id"]}).status_code == 409


def test_csv_round_trip_keeps_status_price_and_source(client, make_item, make_location):
    box = make_location("Export box")
    make_item("Kept", location_id=box["id"], price=9.99, source="Fair")
    gone = make_item("Gone")
    client.patch(f"{API}/items/{gone['id']}", json={"status": "sold", "status_note": "to Sam"})
    csv_text = client.get(f"{API}/export/items.csv", params={"status": ["in_collection", "sold"]}).text
    header = csv_text.splitlines()[0].split(",")
    assert {"item_status", "status_note", "price", "source"} <= set(header)
    assert "9.99" in csv_text and "to Sam" in csv_text


def test_import_reads_status_and_price(client, cats):
    content = (
        "category,model,item_status,status_note,price,location,position\n"
        "CPU,Imported sold,sold,eBay,$12.50,Nowhere,3\n"
        "CPU,Imported wish,wishlist,,,,\n"
        "CPU,Bad status,installed,,,,\n"
    ).encode()
    r = client.post(f"{API}/import/items.csv", files={"file": ("x.csv", content)}, params={"commit": "true", "skip_invalid": "true"})
    assert r.status_code == 200, r.text
    assert r.json()["imported"] == 2 and r.json()["error_rows"] == 1
    sold = client.get(f"{API}/items", params={"status": "sold", "q": "imported"}).json()["items"]
    assert len(sold) == 1 and sold[0]["status_note"] == "eBay" and sold[0]["location_id"] is None
    assert client.get(f"{API}/items/{sold[0]['id']}").json()["price"] == 12.5
    assert {i["model"] for i in client.get(f"{API}/items", params={"status": "wanted"}).json()["items"]} == {"Imported wish"}


def test_a_lent_part_can_be_installed_and_conflicting_requests_are_refused(client, make_item):
    build = make_item("Case", category="Other")
    part = make_item("Lent part")
    client.patch(f"{API}/items/{part['id']}", json={"status": "lent", "status_note": "Sam"})
    installed = client.patch(f"{API}/items/{part['id']}", json={"installed_in_id": build["id"]}).json()
    assert installed["status"] == "installed" and installed["installed_in_id"] == build["id"] and installed["status_note"] is None
    both = client.patch(f"{API}/items/{part['id']}", json={"status": "lent", "installed_in_id": build["id"]})
    assert both.status_code == 422
    sold = make_item("Sold part")
    client.patch(f"{API}/items/{sold['id']}", json={"status": "sold"})
    assert client.patch(f"{API}/items/{sold['id']}", json={"installed_in_id": build["id"]}).status_code == 422


def test_a_sold_item_cannot_be_given_a_location_and_copies_can_be_created_as_wishes(client, make_item, make_location):
    box = make_location("Somewhere")
    sold = make_item("Sold thing")
    client.patch(f"{API}/items/{sold['id']}", json={"status": "sold"})
    assert client.patch(f"{API}/items/{sold['id']}", json={"location_id": box["id"]}).status_code == 422
    assert client.patch(f"{API}/items/{sold['id']}", json={"status": "in_collection", "location_id": box["id"]}).status_code == 200
    cats = client.get(f"{API}/categories").json()
    r = client.post(
        f"{API}/items/batch",
        json={"item": {"category_id": cats[0]["id"], "model": "Wished", "status": "wanted", "location_id": box["id"]}, "copies": 3},
    )
    assert r.status_code == 201 and len(r.json()["created"]) == 3 and r.json()["created"][0]["location_path"] is None
    assert client.get(f"{API}/items", params={"status": "wanted", "q": "wished"}).json()["items"][0]["location_id"] is None


def test_exports_include_sold_and_wishlist_items_unless_a_status_is_chosen(client, make_item):
    keep, sold = make_item("Export keep"), make_item("Export sold")
    client.patch(f"{API}/items/{sold['id']}", json={"status": "sold"})
    wish = make_item("Export wish", status="wanted")
    everything = client.get(f"{API}/export/items.csv").text
    assert all(name in everything for name in ("Export keep", "Export sold", "Export wish"))
    only_sold = client.get(f"{API}/export/items.csv", params={"status": "sold"}).text
    assert "Export sold" in only_sold and "Export keep" not in only_sold
    picked = client.post(f"{API}/items/bulk-export", json={"ids": [sold["id"], wish["id"]]}).text
    assert "Export sold" in picked and "Export wish" in picked and keep["model"] not in picked
