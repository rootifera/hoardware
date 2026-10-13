import pytest

API = "/api/v1"


def models(client, **params):
    r = client.get(f"{API}/items", params=params)
    assert r.status_code == 200, r.text
    return [i["model"] for i in r.json()["items"]]


def test_search_matches_each_field(client, make_item):
    make_item("Viper V770 Ultra", category="GPU/VGA", manufacturer="Diamond", part_number="23130000-A", chipset="RIVA TNT2 Ultra", chipset_manufacturer="NVIDIA", notes="has bracket")
    make_item("Voodoo3 3000", category="GPU/VGA", manufacturer="3dfx")
    assert models(client, q="diamond") == ["Viper V770 Ultra"]
    assert models(client, q="viper") == ["Viper V770 Ultra"]
    assert models(client, q="23130000") == ["Viper V770 Ultra"]
    assert models(client, q="tnt2") == ["Viper V770 Ultra"]
    assert models(client, q="nvidia") == ["Viper V770 Ultra"]
    assert models(client, q="bracket") == ["Viper V770 Ultra"]
    assert models(client, q="VOODOO") == ["Voodoo3 3000"]


def test_search_is_substring_and_multi_token(client, make_item):
    make_item("Pentium III 600E", manufacturer="Intel")
    make_item("Pentium II 300", manufacturer="Intel")
    assert sorted(models(client, q="ntium")) == ["Pentium II 300", "Pentium III 600E"]
    assert models(client, q="intel 600") == ["Pentium III 600E"]
    assert models(client, q="600 intel pentium") == ["Pentium III 600E"]
    assert models(client, q="nothing here") == []


def test_search_by_inventory_code(client, make_item):
    make_item("one")
    two = make_item("two")
    assert models(client, q=two["inventory_code"]) == ["two"]
    assert models(client, q="hw-2") == ["two"]
    assert models(client, q="2") == ["two"]


def test_search_treats_like_wildcards_literally(client, make_item):
    make_item("100% genuine")
    make_item("plain")
    assert models(client, q="%") == ["100% genuine"]
    assert models(client, q="_") == []


def test_filters_combine(client, make_item, cats):
    make_item("a", category="CPU", manufacturer="Intel", condition="Good", test_status="POST")
    make_item("b", category="CPU", manufacturer="AMD", condition="Good", test_status="Dead")
    make_item("c", category="GPU/VGA", manufacturer="Intel", condition="Poor", test_status="POST", identification_confidence="confirmed")
    assert sorted(models(client, category_id=cats["CPU"])) == ["a", "b"]
    assert sorted(models(client, manufacturer="intel")) == ["a", "c"]
    assert models(client, manufacturer="intel", condition="Good") == ["a"]
    assert sorted(models(client, condition=["Good", "Poor"])) == ["a", "b", "c"]
    assert models(client, test_status="Dead") == ["b"]
    assert models(client, identification_confidence="confirmed") == ["c"]
    assert models(client, q="intel", category_id=cats["GPU/VGA"], test_status="POST") == ["c"]


def test_invalid_filter_values_are_rejected(client):
    assert client.get(f"{API}/items", params={"condition": "Mint"}).status_code == 422
    assert client.get(f"{API}/items", params={"sort": "bogus"}).status_code == 422
    assert client.get(f"{API}/items", params={"limit": 0}).status_code == 422
    assert client.get(f"{API}/items", params={"limit": 100000}).status_code == 422
    assert client.get(f"{API}/items", params={"cursor": "garbage!!"}).status_code == 422


def test_manufacturer_autocomplete(client, make_item):
    for m in ("Intel", "intel", "AMD", "Creative Labs"):
        make_item("x", manufacturer=m)
    r = client.get(f"{API}/manufacturers", params={"q": "i"})
    assert [m.lower() for m in r.json()] == ["intel"]
    assert len(client.get(f"{API}/manufacturers").json()) == 3


def test_default_order_is_newest_first(client, make_item):
    for name in ("first", "second", "third"):
        make_item(name)
    assert models(client) == ["third", "second", "first"]
    assert models(client, order="asc") == ["first", "second", "third"]


@pytest.mark.parametrize("sort", ["newest", "name", "category", "location", "position"])
@pytest.mark.parametrize("order", ["asc", "desc"])
def test_cursor_pagination_visits_every_row_once_in_order(client, make_item, make_location, sort, order):
    shelf_a, shelf_b = make_location("A"), make_location("B")
    cats_cycle = ["CPU", "GPU/VGA", "RAM"]
    expected = []
    for i in range(23):
        # Many ties on every sort key except id.
        item = make_item(f"part {i % 4}", category=cats_cycle[i % 3], location_id=[None, shelf_a["id"], shelf_b["id"]][i % 3])
        expected.append(item["id"])

    seen, cursor, pages = [], None, 0
    while True:
        params = {"sort": sort, "order": order, "limit": 5}
        if cursor:
            params["cursor"] = cursor
        page = client.get(f"{API}/items", params=params).json()
        seen += [i["id"] for i in page["items"]]
        pages += 1
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert pages == 5
    assert sorted(seen) == sorted(expected)
    assert len(seen) == len(set(seen))

    # Order must match a single un-paginated query.
    full = client.get(f"{API}/items", params={"sort": sort, "order": order, "limit": 200}).json()
    assert seen == [i["id"] for i in full["items"]]


def test_cursor_for_another_sort_is_rejected(client, make_item):
    for i in range(3):
        make_item(f"p{i}")
    cursor = client.get(f"{API}/items", params={"limit": 1}).json()["next_cursor"]
    assert client.get(f"{API}/items", params={"sort": "name", "cursor": cursor}).status_code == 422


def test_with_total(client, make_item):
    for i in range(7):
        make_item(f"p{i}")
    page = client.get(f"{API}/items", params={"limit": 2, "with_total": True}).json()
    assert page["total"] == 7 and len(page["items"]) == 2
    assert client.get(f"{API}/items", params={"limit": 2}).json()["total"] is None
    assert client.get(f"{API}/items", params={"q": "p1", "with_total": True}).json()["total"] == 1


def test_empty_result_has_no_cursor(client):
    page = client.get(f"{API}/items").json()
    assert page == {"items": [], "next_cursor": None, "total": None}
