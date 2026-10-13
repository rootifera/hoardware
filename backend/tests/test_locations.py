API = "/api/v1"


def models(client, **params):
    return sorted(i["model"] for i in client.get(f"{API}/items", params=params).json()["items"])


def test_full_path_is_shown_for_nested_locations(client, make_location, make_item):
    workshop = make_location("Workshop")
    shelf = make_location("Shelf 2", workshop["id"])
    box = make_location("CPU Box 3", shelf["id"])
    assert box["full_name"] == "Workshop > Shelf 2 > CPU Box 3"
    assert [a["name"] for a in box["ancestors"]] == ["Workshop", "Shelf 2"]
    item = make_item("486", location_id=box["id"])
    assert item["location_path"] == "Workshop > Shelf 2 > CPU Box 3"
    listed = client.get(f"{API}/items").json()["items"][0]
    assert listed["location_path"] == "Workshop > Shelf 2 > CPU Box 3"


def test_filter_by_location_including_descendants(client, make_location, make_item):
    shelf = make_location("Shelf")
    box1 = make_location("Box 1", shelf["id"])
    box2 = make_location("Box 2", shelf["id"])
    other = make_location("Other shelf")
    make_item("on shelf", location_id=shelf["id"])
    make_item("in box 1", location_id=box1["id"])
    make_item("in box 2", location_id=box2["id"])
    make_item("elsewhere", location_id=other["id"])
    make_item("nowhere")

    assert models(client, location_id=shelf["id"]) == ["in box 1", "in box 2", "on shelf"]
    assert models(client, location_id=shelf["id"], include_descendants=False) == ["on shelf"]
    assert models(client, location_id=box1["id"]) == ["in box 1"]
    assert models(client, unassigned=True) == ["nowhere"]
    assert client.get(f"{API}/items", params={"location_id": 9999}).status_code == 404


def test_location_filter_does_not_match_id_prefixes(client, make_location, make_item):
    # ids 1 and 10..: path "/1/" must not match "/10/".
    first = make_location("first")
    for i in range(9):
        make_location(f"filler {i}")
    tenth = make_location("tenth")
    assert tenth["id"] == 11 or tenth["id"] > first["id"]
    make_item("in first", location_id=first["id"])
    make_item("in tenth", location_id=tenth["id"])
    assert models(client, location_id=first["id"]) == ["in first"]


def test_rename_updates_descendant_paths(client, make_location, make_item):
    a = make_location("A")
    b = make_location("B", a["id"])
    c = make_location("C", b["id"])
    item = make_item("x", location_id=c["id"])
    r = client.patch(f"{API}/locations/{a['id']}", json={"name": "Workshop"})
    assert r.status_code == 200 and r.json()["full_name"] == "Workshop"
    assert client.get(f"{API}/locations/{c['id']}").json()["full_name"] == "Workshop > B > C"
    assert client.get(f"{API}/items/{item['id']}").json()["location_path"] == "Workshop > B > C"


def test_move_subtree(client, make_location, make_item):
    a = make_location("A")
    b = make_location("B", a["id"])
    c = make_location("C", b["id"])
    z = make_location("Z")
    item = make_item("x", location_id=c["id"])

    r = client.patch(f"{API}/locations/{b['id']}", json={"parent_id": z["id"]})
    assert r.status_code == 200
    assert client.get(f"{API}/locations/{c['id']}").json()["full_name"] == "Z > B > C"
    assert client.get(f"{API}/items/{item['id']}").json()["location_path"] == "Z > B > C"
    assert models(client, location_id=a["id"]) == []
    assert models(client, location_id=z["id"]) == ["x"]

    # Back to the root.
    client.patch(f"{API}/locations/{b['id']}", json={"parent_id": None})
    assert client.get(f"{API}/locations/{c['id']}").json()["full_name"] == "B > C"
    assert client.get(f"{API}/locations/{c['id']}").json()["ancestors"] == [{"id": b["id"], "name": "B"}]


def test_cycles_are_rejected(client, make_location):
    a = make_location("A")
    b = make_location("B", a["id"])
    c = make_location("C", b["id"])
    assert client.patch(f"{API}/locations/{a['id']}", json={"parent_id": c["id"]}).status_code == 422
    assert client.patch(f"{API}/locations/{a['id']}", json={"parent_id": a["id"]}).status_code == 422
    assert client.patch(f"{API}/locations/{a['id']}", json={"parent_id": b["id"]}).status_code == 422
    # Prefix-id lookalike is not a cycle: "/1/" vs "/10/".
    assert client.get(f"{API}/locations/{a['id']}").json()["parent_id"] is None


def test_sibling_names_are_unique_but_cousins_may_repeat(client, make_location):
    a = make_location("A")
    b = make_location("B")
    make_location("Box", a["id"])
    make_location("Box", b["id"])
    r = client.post(f"{API}/locations", json={"name": "box", "parent_id": a["id"]})
    assert r.status_code == 409
    child = make_location("Other", a["id"])
    assert client.patch(f"{API}/locations/{child['id']}", json={"name": "BOX"}).status_code == 409
    assert client.post(f"{API}/locations", json={"name": "A"}).status_code == 409


def test_unknown_parent_and_blank_name(client):
    assert client.post(f"{API}/locations", json={"name": "x", "parent_id": 999}).status_code == 422
    assert client.post(f"{API}/locations", json={"name": "  "}).status_code == 422
    assert client.patch(f"{API}/locations/999", json={"name": "x"}).status_code == 404


def test_delete_rules(client, make_location, make_item):
    a = make_location("A")
    b = make_location("B", a["id"])
    make_item("x", location_id=b["id"])
    assert client.delete(f"{API}/locations/{a['id']}").status_code == 409  # has child
    assert client.delete(f"{API}/locations/{b['id']}").status_code == 409  # has item
    item_id = client.get(f"{API}/items").json()["items"][0]["id"]
    client.patch(f"{API}/items/{item_id}", json={"location_id": None})
    assert client.delete(f"{API}/locations/{b['id']}").status_code == 204
    assert client.delete(f"{API}/locations/{a['id']}").status_code == 204
    assert client.get(f"{API}/locations/{a['id']}").status_code == 404


def test_lazy_tree_listing_and_search(client, make_location):
    a = make_location("Alpha")
    make_location("beta")
    make_location("Gamma Box", a["id"])
    roots = client.get(f"{API}/locations").json()["items"]
    assert [(r["name"], r["has_children"]) for r in roots] == [("Alpha", True), ("beta", False)]
    children = client.get(f"{API}/locations", params={"parent_id": a["id"]}).json()["items"]
    assert [c["name"] for c in children] == ["Gamma Box"]
    found = client.get(f"{API}/locations", params={"q": "alpha gamma"}).json()["items"]
    assert [f["full_name"] for f in found] == ["Alpha > Gamma Box"]


def test_location_pagination(client, make_location):
    for i in range(7):
        make_location(f"loc {i}")
    names, cursor = [], None
    while True:
        params = {"limit": 3, **({"cursor": cursor} if cursor else {})}
        page = client.get(f"{API}/locations", params=params).json()
        names += [i["name"] for i in page["items"]]
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert names == [f"loc {i}" for i in range(7)]
