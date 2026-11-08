from concurrent.futures import ThreadPoolExecutor

API = "/api/v1"


def stock_item(make_item, quantity=100, **extra):
    return make_item("10uF capacitor", is_stock=True, quantity=quantity, **extra)


def history(client, item_id):
    return client.get(f"{API}/items/{item_id}/stock-log").json()


def test_take_out_and_add_change_the_quantity_and_are_logged(client, make_item):
    item = stock_item(make_item)
    r = client.post(f"{API}/items/{item['id']}/stock", json={"change": -10, "note": "amp build"})
    assert r.status_code == 200 and r.json()["quantity"] == 90
    assert r.json()["entry"]["change"] == -10 and r.json()["entry"]["quantity_after"] == 90 and r.json()["entry"]["note"] == "amp build"
    assert client.post(f"{API}/items/{item['id']}/stock", json={"change": 25}).json()["quantity"] == 115
    assert client.get(f"{API}/items/{item['id']}").json()["quantity"] == 115
    log = history(client, item["id"])
    assert [(e["change"], e["quantity_after"]) for e in log] == [(25, 115), (-10, 90), (100, 100)]  # newest first, starting stock last
    assert log[-1]["note"] == "Starting stock"


def test_you_cannot_take_out_more_than_there_is(client, make_item):
    item = stock_item(make_item, quantity=5)
    r = client.post(f"{API}/items/{item['id']}/stock", json={"change": -6})
    assert r.status_code == 409 and "only 5 left" in r.json()["detail"]
    assert client.get(f"{API}/items/{item['id']}").json()["quantity"] == 5  # untouched
    assert client.post(f"{API}/items/{item['id']}/stock", json={"change": -5}).json()["quantity"] == 0  # exactly all of it is fine
    assert client.post(f"{API}/items/{item['id']}/stock", json={"change": -1}).status_code == 409
    assert len(history(client, item["id"])) == 2  # starting stock + the take-out; refused ones leave no trace


def test_only_stock_items_and_real_changes(client, make_item):
    single = make_item("Pentium")
    r = client.post(f"{API}/items/{single['id']}/stock", json={"change": -1})
    assert r.status_code == 409 and "not tracked as stock" in r.json()["detail"]
    assert client.post(f"{API}/items/99999/stock", json={"change": 1}).status_code == 404
    item = stock_item(make_item)
    for bad in ({"change": 0}, {"change": 1.5}, {"change": "x"}, {"change": 2_000_000_000}, {"change": 1, "note": "x" * 201}):
        assert client.post(f"{API}/items/{item['id']}/stock", json=bad).status_code == 422, bad
    assert client.get(f"{API}/items/99999/stock-log").status_code == 404


def test_editing_the_quantity_or_the_flag_is_recorded(client, make_item):
    single = make_item("Screws")
    assert history(client, single["id"]) == []  # not stock: no history
    on = client.patch(f"{API}/items/{single['id']}", json={"is_stock": True, "quantity": 500}).json()
    assert on["is_stock"] and on["quantity"] == 500
    client.patch(f"{API}/items/{single['id']}", json={"quantity": 450})
    client.patch(f"{API}/items/{single['id']}", json={"model": "Screws M3"})  # no quantity change: nothing logged
    log = history(client, single["id"])
    assert [(e["change"], e["quantity_after"], e["note"]) for e in log] == [(-50, 450, "Quantity edited"), (500, 500, "Started tracking as stock")]


def test_history_goes_with_the_item(client, make_item, db):
    from app.models import StockLog

    item = stock_item(make_item)
    client.post(f"{API}/items/{item['id']}/stock", json={"change": -1})
    assert db.query(StockLog).count() == 2
    client.delete(f"{API}/items/{item['id']}")
    db.expire_all()
    assert db.query(StockLog).count() == 0


def test_simultaneous_take_outs_never_oversell(client, make_item):
    item = stock_item(make_item, quantity=5)

    def take(_):
        return client.post(f"{API}/items/{item['id']}/stock", json={"change": -1}).status_code

    with ThreadPoolExecutor(max_workers=8) as pool:
        codes = list(pool.map(take, range(12)))
    assert codes.count(200) == 5 and codes.count(409) == 7
    assert client.get(f"{API}/items/{item['id']}").json()["quantity"] == 0


def test_low_stock_level_and_filter(client, make_item):
    low = stock_item(make_item, quantity=8, low_stock_level=10)
    stock_item(make_item, quantity=50, low_stock_level=10)
    make_item("No level", is_stock=True, quantity=1)
    make_item("Single thing")
    got = client.get(f"{API}/items", params={"low_stock": "true"}).json()["items"]
    assert [i["id"] for i in got] == [low["id"]] and got[0]["low_stock_level"] == 10
    client.post(f"{API}/items/{low['id']}/stock", json={"change": 100})
    assert client.get(f"{API}/items", params={"low_stock": "true"}).json()["items"] == []  # restocked
    assert client.patch(f"{API}/items/{low['id']}", json={"low_stock_level": -1}).status_code == 422
    assert client.patch(f"{API}/items/{low['id']}", json={"low_stock_level": None}).json()["low_stock_level"] is None


def test_selecting_everything_that_matches_low_stock_never_touches_other_items(client, make_item):
    low = stock_item(make_item, quantity=3, low_stock_level=10)
    fine = stock_item(make_item, quantity=300, low_stock_level=10)
    single = make_item("Pentium")
    base = {"q": None, "category_id": [], "condition": [], "test_status": [], "identification_confidence": [], "include_descendants": True, "unassigned": False, "never_verified": False}
    r = client.post(f"{API}/items/bulk-delete", json={"selection": {"filter": {**base, "low_stock": True}}})
    assert r.status_code == 200 and r.json()["deleted"] == 1
    assert client.get(f"{API}/items/{low['id']}").status_code == 404
    assert client.get(f"{API}/items/{fine['id']}").status_code == 200 and client.get(f"{API}/items/{single['id']}").status_code == 200
