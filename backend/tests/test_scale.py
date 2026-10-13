"""Scale checks: 100k items, a deep-ish location tree. Verifies that the
important queries use their indexes and stay fast. Run with -m scale."""

import time

import pytest
from sqlalchemy import text

API = "/api/v1"
N = 100_000

pytestmark = pytest.mark.scale


@pytest.fixture
def big(db):
    db.execute(
        text(
            """
            INSERT INTO items (category_id, manufacturer, model, part_number, condition, test_status, notes)
            SELECT (SELECT id FROM categories ORDER BY id OFFSET (g % 7) LIMIT 1),
                   (ARRAY['Intel','AMD','Cyrix','Diamond','Creative','3dfx','ATI'])[1 + g % 7],
                   'Model ' || md5(g::text),
                   'PN-' || lpad(g::text, 7, '0'),
                   (ARRAY['Unknown','Good','Fair','Poor','Excellent'])[1 + g % 5],
                   (ARRAY['Untested','Untested','Unknown','POST','Full Test','Dead'])[1 + g % 6],
                   'note ' || g
            FROM generate_series(1, :n) g
            """
        ),
        {"n": N},
    )
    db.execute(text("ANALYZE items"))
    db.commit()


def timed(client, **params):
    start = time.perf_counter()
    r = client.get(f"{API}/items", params=params)
    elapsed = time.perf_counter() - start
    assert r.status_code == 200, r.text
    return r.json(), elapsed


def plan(db, sql, **params):
    return "\n".join(row[0] for row in db.execute(text("EXPLAIN " + sql), params))


def test_search_uses_trigram_index(db, big):
    out = plan(db, "SELECT id FROM items WHERE search_text LIKE '%pn-0050000%'")
    assert "ix_items_search_text_trgm" in out, out


def test_default_listing_is_index_ordered(db, big):
    out = plan(db, "SELECT id FROM items ORDER BY id DESC LIMIT 51")
    assert "Seq Scan" not in out and "Sort" not in out, out


def test_filtered_listing_avoids_seq_scan_and_sort(db, big):
    out = plan(db, "SELECT id FROM items WHERE test_status = 'Dead' ORDER BY id DESC LIMIT 51")
    assert "Seq Scan" not in out and "Sort" not in out, out
    # A rare filter value must use its composite (filter, id DESC) index.
    out = plan(db, "SELECT id FROM items WHERE category_id = -1 ORDER BY id DESC LIMIT 51")
    assert "ix_items_category" in out, out


def test_name_sort_uses_index(db, big):
    out = plan(db, "SELECT id FROM items ORDER BY sort_name, id LIMIT 51")
    assert "ix_items_sort_name" in out, out


def test_endpoints_stay_fast_with_100k_items(client, big):
    page, elapsed = timed(client)
    assert len(page["items"]) == 50 and page["next_cursor"]
    assert elapsed < 0.5

    page, elapsed = timed(client, q="pn-0050000")
    assert [i["part_number"] for i in page["items"]] == ["PN-0050000"]
    assert elapsed < 0.5

    page, elapsed = timed(client, q="model 7f", test_status="Dead", limit=20)
    assert elapsed < 1.0

    # Deep keyset page: no offset scan.
    cursor = None
    for _ in range(40):
        page, elapsed = timed(client, limit=200, **({"cursor": cursor} if cursor else {}))
        cursor = page["next_cursor"]
        assert elapsed < 0.5
    assert cursor

    page, elapsed = timed(client, sort="name", limit=50)
    assert elapsed < 0.75


def test_location_subtree_filter_at_scale(client, db, make_location, big):
    root = make_location("Root")
    box = make_location("Box", make_location("Shelf", root["id"])["id"])
    db.execute(text("UPDATE items SET location_id = :l WHERE id % 1000 = 0"), {"l": box["id"]})
    db.commit()
    page, elapsed = timed(client, location_id=root["id"], with_total=True)
    assert page["total"] == N // 1000
    assert elapsed < 0.5
