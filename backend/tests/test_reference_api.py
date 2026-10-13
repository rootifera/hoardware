import pytest

from app.reference.cpudb import CpuDbAdapter
from app.reference.runner import run_import
from tests.cpudb_data import row, write_vendor

API = "/api/v1"


@pytest.fixture
def cpudb(tmp_path, db):
    """A small made-up dataset in the CPU-DB shape."""
    write_vendor(
        tmp_path,
        "Acme",
        [
            row("Acme", "Widget MMX", "A80503150 Q0939", {"Frequency(internal max/typ)": "150MHz", "Package": "SPGA", "Socket": "Socket 7"}),
            row("Acme", "Widget MMX", "A80503150 Q974", {"Frequency(internal max/typ)": "150MHz", "Package": "SPGA"}),
            row("Acme", "Widget MMX", "A80503166 Q0940", {"Frequency(internal max/typ)": "166MHz"}),
            row("Acme", "Widget", "W100", {"Alternative Label 1": "W-100-ALT", "L2 cache": "NA"}),
            row("Globex", "Widget", "W100", {"Frequency(internal max/typ)": "66MHz"}),
            row("Globex", "Gizmo", "GZ2000", {"Frequency(internal max/typ)": "200MHz"}),
        ],
    )
    run_import(db, CpuDbAdapter(), tmp_path)
    return tmp_path


def candidates(client, item_id, **params):
    r = client.get(f"{API}/items/{item_id}/reference-candidates", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def label(c):
    ref = c["reference"]
    return f"{ref['manufacturer']} {ref['model']}"


def test_core_app_works_with_no_reference_data(client, make_item):
    assert client.get(f"{API}/reference-sources").json() == []
    assert client.get(f"{API}/reference-models").json()["items"] == []
    item = make_item("Whatever", part_number="W100")
    assert candidates(client, item["id"]) == []
    assert client.get(f"{API}/items/{item['id']}").json()["reference"] is None


def test_sources_report_counts_and_version(client, cpudb):
    (source,) = client.get(f"{API}/reference-sources").json()
    assert source["key"] == "cpu-db" and source["models"] == 6
    assert source["source_version"].startswith("sha1:") and source["last_import_at"]


def test_reference_model_search_and_detail(client, cpudb):
    page = client.get(f"{API}/reference-models", params={"q": "widget mmx"}).json()
    assert [r["model"] for r in page["items"]] == ["A80503150 Q0939", "A80503150 Q974", "A80503166 Q0940"]
    assert page["items"][0]["highlights"]["Socket"] == "Socket 7"
    assert client.get(f"{API}/reference-models", params={"manufacturer": "globex"}).json()["items"][0]["family"] in {"Gizmo", "Widget"}
    assert client.get(f"{API}/reference-models", params={"kind": "gpu_chipset"}).json()["items"] == []

    detail = client.get(f"{API}/reference-models/{page['items'][0]['id']}").json()
    assert detail["specs"]["Package"] == "SPGA"
    assert detail["source"]["name"] == "CPU-DB" and detail["provenance"]["file"] == "cpu-db.Acme.csv"
    assert client.get(f"{API}/reference-models/999999").status_code == 404


def test_reference_model_pagination(client, cpudb):
    seen, cursor = [], None
    while True:
        params = {"limit": 2, **({"cursor": cursor} if cursor else {})}
        page = client.get(f"{API}/reference-models", params=params).json()
        seen += [r["id"] for r in page["items"]]
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert len(seen) == 6 and len(set(seen)) == 6


def test_exact_part_number_match_ranks_first(client, make_item, cpudb):
    item = make_item("Some CPU", manufacturer="Acme", part_number="a80503150 q0939")
    result = candidates(client, item["id"])
    assert label(result[0]) == "Acme A80503150 Q0939" and result[0]["match_type"] == "exact"
    # The other steppings share the ordering code, so they are offered after it.
    assert {label(c) for c in result[1:3]} == {"Acme A80503150 Q974"}
    assert all(c["match_type"] == "token" for c in result[1:3])


def test_partial_ordering_code_returns_all_variants_as_candidates(client, make_item, cpudb):
    item = make_item("Pentium-ish", part_number="A80503150")
    result = candidates(client, item["id"])
    assert [c["match_type"] for c in result[:2]] == ["token", "token"]
    assert {label(c) for c in result[:2]} == {"Acme A80503150 Q0939", "Acme A80503150 Q974"}


def test_matching_on_the_spec_number_alone(client, make_item, cpudb):
    item = make_item("unknown chip", part_number="Q974")
    result = candidates(client, item["id"])
    assert [label(c) for c in result] == ["Acme A80503150 Q974"] and result[0]["match_type"] == "token"
    assert result[0]["matched_on"] == ["q974"]


def test_alias_counts_as_an_exact_match(client, make_item, cpudb):
    item = make_item("alias test", part_number="W-100-ALT")
    result = candidates(client, item["id"])
    assert result[0]["match_type"] == "exact" and label(result[0]) == "Acme W100"


def test_manufacturer_breaks_ties_between_identical_part_numbers(client, make_item, cpudb):
    item = make_item("Some CPU", manufacturer="Globex", part_number="W100")
    result = candidates(client, item["id"])
    assert [label(c) for c in result[:2]] == ["Globex W100", "Acme W100"]
    assert [c["manufacturer_matches"] for c in result[:2]] == [True, False]


def test_text_candidates_are_not_mixed_in_with_identifier_matches(client, make_item, cpudb):
    item = make_item("Widget MMX", manufacturer="Acme", part_number="A80503150")
    assert {c["match_type"] for c in candidates(client, item["id"])} == {"token"}


def test_name_only_items_get_text_candidates(client, make_item, cpudb):
    item = make_item("Widget MMX 150", manufacturer="Acme")
    result = candidates(client, item["id"])
    assert result and all(c["match_type"] == "text" and c["matched_on"] == [] for c in result)
    assert "Acme A80503150 Q0939" in {label(c) for c in result}


def test_placeholder_descriptions_do_not_produce_noise(client, make_item, cpudb):
    item = make_item("Unknown ISA VGA card")
    assert candidates(client, item["id"]) == []


def test_candidates_404_for_unknown_item(client):
    assert client.get(f"{API}/items/999/reference-candidates").status_code == 404


def test_link_confirm_and_unlink(client, make_item, cpudb):
    item = make_item("My CPU", manufacturer="Acme", part_number="A80503150 Q0939", attributes={"Socket": "my own value"})
    ref_id = candidates(client, item["id"])[0]["reference"]["id"]

    r = client.post(f"{API}/items/{item['id']}/reference-match", json={"reference_model_id": ref_id, "confidence": "candidate"})
    assert r.status_code == 200
    body = r.json()
    assert body["reference_model_id"] == ref_id and body["identification_confidence"] == "candidate"
    assert body["reference"]["specs"]["Socket"] == "Socket 7"
    # The match's specs are now the item's own; what the user typed wins.
    assert body["attributes"]["Socket"] == "my own value"
    assert body["attributes"]["Speed"] == "150MHz" and body["attributes"]["Package"] == "SPGA"
    assert body["model"] == "My CPU" and body["manufacturer"] == "Acme"  # item fields are never overwritten

    r = client.post(f"{API}/items/{item['id']}/reference-match", json={"reference_model_id": ref_id})
    assert r.json()["identification_confidence"] == "confirmed"

    r = client.delete(f"{API}/items/{item['id']}/reference-match")
    body = r.json()
    assert body["reference"] is None and body["reference_model_id"] is None
    assert body["identification_confidence"] == "unidentified"
    assert body["attributes"]["Socket"] == "my own value" and body["attributes"]["Speed"] == "150MHz"  # kept after unlinking


def test_link_validation(client, make_item, cpudb):
    item = make_item("x")
    ref_id = client.get(f"{API}/reference-models").json()["items"][0]["id"]
    assert client.post(f"{API}/items/{item['id']}/reference-match", json={"reference_model_id": 999999}).status_code == 422
    assert client.post(f"{API}/items/{item['id']}/reference-match", json={"reference_model_id": ref_id, "confidence": "unidentified"}).status_code == 422
    assert client.post(f"{API}/items/999999/reference-match", json={"reference_model_id": ref_id}).status_code == 404
    assert client.delete(f"{API}/items/999999/reference-match").status_code == 404


def test_one_reference_model_can_back_many_items_and_deleting_items_keeps_it(client, make_item, cpudb):
    ref_id = client.get(f"{API}/reference-models").json()["items"][0]["id"]
    a, b = make_item("a"), make_item("b")
    for item in (a, b):
        client.post(f"{API}/items/{item['id']}/reference-match", json={"reference_model_id": ref_id})
    assert client.delete(f"{API}/items/{a['id']}").status_code == 204
    assert client.get(f"{API}/items/{b['id']}").json()["reference"]["id"] == ref_id
    assert client.get(f"{API}/reference-models/{ref_id}").status_code == 200


def test_identification_filter_still_works_after_linking(client, make_item, cpudb):
    item = make_item("linked")
    make_item("not linked")
    ref_id = client.get(f"{API}/reference-models").json()["items"][0]["id"]
    client.post(f"{API}/items/{item['id']}/reference-match", json={"reference_model_id": ref_id, "confidence": "confirmed"})
    page = client.get(f"{API}/items", params={"identification_confidence": "confirmed"}).json()
    assert [i["model"] for i in page["items"]] == ["linked"]


def test_suggestions_while_typing_use_the_same_ranking(client, cpudb):
    r = client.get(f"{API}/reference-suggestions", params={"q": "a80503150 q0939"})
    result = r.json()
    assert r.status_code == 200 and result[0]["match_type"] == "exact"
    assert result[0]["reference"]["model"] == "A80503150 Q0939"
    spec_only = client.get(f"{API}/reference-suggestions", params={"q": "Q974"}).json()
    assert [c["reference"]["model"] for c in spec_only] == ["A80503150 Q974"] and spec_only[0]["match_type"] == "token"
    by_name = client.get(f"{API}/reference-suggestions", params={"q": "widget mmx"}).json()
    assert by_name and all(c["match_type"] == "text" for c in by_name)
    assert client.get(f"{API}/reference-suggestions", params={"q": "zzzz nothing"}).json() == []
    assert client.get(f"{API}/reference-suggestions", params={"q": "x"}).status_code == 422
    assert len(client.get(f"{API}/reference-suggestions", params={"q": "widget", "limit": 2}).json()) <= 2


def test_suggestions_are_empty_without_a_dataset(client):
    assert client.get(f"{API}/reference-suggestions", params={"q": "pentium"}).json() == []


def test_creating_an_item_with_a_picked_match(client, cats, cpudb):
    ref = client.get(f"{API}/reference-suggestions", params={"q": "A80503150 Q0939"}).json()[0]["reference"]
    r = client.post(f"{API}/items", json={"category_id": cats["CPU"], "model": "Widget MMX", "reference_model_id": ref["id"], "identification_confidence": "confirmed"})
    assert r.status_code == 201
    body = r.json()
    assert body["reference_model_id"] == ref["id"] and body["identification_confidence"] == "confirmed"
    assert body["reference"]["model"] == "A80503150 Q0939"
    bad = client.post(f"{API}/items", json={"category_id": cats["CPU"], "model": "x", "reference_model_id": 999999})
    assert bad.status_code == 422


def test_batch_copies_all_carry_the_match(client, cats, cpudb):
    ref = client.get(f"{API}/reference-suggestions", params={"q": "A80503150 Q0939"}).json()[0]["reference"]
    r = client.post(f"{API}/items/batch", json={"item": {"category_id": cats["CPU"], "model": "Widget MMX", "reference_model_id": ref["id"]}, "copies": 3})
    ids = [c["id"] for c in r.json()["created"]]
    assert all(client.get(f"{API}/items/{i}").json()["reference_model_id"] == ref["id"] for i in ids)
    assert client.post(f"{API}/items/batch", json={"item": {"category_id": cats["CPU"], "model": "x", "reference_model_id": 999999}, "copies": 2}).status_code == 422


def test_short_fragments_do_not_produce_text_matches(client, make_item, cpudb):
    assert client.get(f"{API}/reference-suggestions", params={"q": "AC-1"}).json() == []
    assert client.get(f"{API}/reference-suggestions", params={"q": "ab"}).json() == []
    item = make_item("AC-1", manufacturer="Acme")
    assert candidates(client, item["id"]) == []
