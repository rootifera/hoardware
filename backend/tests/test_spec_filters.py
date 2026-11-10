API = "/api/v1"


def models(client, **params):
    r = client.get(f"{API}/items", params={"limit": 200, **params})
    assert r.status_code == 200, r.text
    return [i["model"] for i in r.json()["items"]]


def seed(make_item):
    make_item("A", attributes={"Speed": "133MHz", "Socket": "Socket 7", "Cache": "512KiB"})
    make_item("B", attributes={"Speed": "1.2GHz", "Socket": "Socket A", "Cache": "1MiB"})
    make_item("C", attributes={"Speed": "66 MHz", "Socket": "socket 7"})
    make_item("D", attributes={"Speed": "fast"})
    make_item("E")


def test_equals_ignores_case(client, make_item):
    seed(make_item)
    assert sorted(models(client, spec_key="Socket", spec_value="SOCKET 7")) == ["A", "C"]


def test_min_and_max_understand_units(client, make_item):
    seed(make_item)
    assert sorted(models(client, spec_key="Speed", spec_op="min", spec_value="100MHz")) == ["A", "B"]
    assert sorted(models(client, spec_key="Speed", spec_op="max", spec_value="0.5GHz")) == ["A", "C"]
    assert sorted(models(client, spec_key="Cache", spec_op="min", spec_value="1MB")) == ["B"]
    r = client.get(f"{API}/items", params={"spec_key": "Speed", "spec_op": "min", "spec_value": "fast"})
    assert r.status_code == 422


def test_sort_by_spec_value_numerically_with_blanks_last(client, make_item):
    seed(make_item)
    assert models(client, sort="spec", spec_key="Speed") == ["C", "A", "B", "D", "E"]
    assert models(client, sort="spec", spec_key="Speed", order="desc") == ["B", "A", "C", "E", "D"]  # ties: newest first
    assert client.get(f"{API}/items", params={"sort": "spec"}).status_code == 422


def test_paging_through_a_spec_sort(client, make_item):
    for n in range(7):
        make_item(f"P{n}", attributes={"Speed": f"{(n % 3) * 100}MHz"})
    seen, cursor = [], None
    while True:
        params = {"sort": "spec", "spec_key": "Speed", "limit": 2, **({"cursor": cursor} if cursor else {})}
        page = client.get(f"{API}/items", params=params).json()
        seen += [i["model"] for i in page["items"]]
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert len(seen) == len(set(seen)) == 7  # every item exactly once


def test_bulk_selection_by_spec_filter(client, make_item):
    seed(make_item)
    r = client.post(
        f"{API}/items/bulk",
        json={
            "selection": {"filter": {"spec_key": "Socket", "spec_value": "Socket 7"}},
            "changes": {"attributes": {"Era": "Pentium"}},
        },
    )
    assert r.status_code == 200 and r.json()["matched"] == 2
