API = "/api/v1"

HEADER = "category,manufacturer,model,part_number,condition,test_status,location,position,notes,acquired_on\n"


def upload(client, content, **params):
    data = content.encode("utf-8") if isinstance(content, str) else content
    r = client.post(f"{API}/import/items.csv", params=params, files={"file": ("items.csv", data, "text/csv")})
    assert r.status_code == 200, r.text
    return r.json()


def items(client, **params):
    return client.get(f"{API}/items", params={"limit": 200, "sort": "name", **params}).json()["items"]


def test_preview_validates_and_writes_nothing(client, make_location):
    make_location("Shelf")
    report = upload(client, HEADER + "CPU,Intel,Pentium MMX 200,,Good,Full Test,Shelf,1,,2020-05-01\nGPU/VGA,,Unknown PCI video card,,,,,,,\n")
    assert (report["total_rows"], report["valid_rows"], report["error_rows"]) == (2, 2, 0)
    assert report["committed"] is False and report["imported"] == 0
    assert report["preview"][0]["model"] == "Pentium MMX 200" and report["preview"][0]["position"] == 1
    assert items(client) == []


def test_commit_creates_new_items_with_defaults(client, make_location):
    shelf = make_location("Shelf")
    report = upload(client, HEADER + "CPU,Intel,Pentium MMX 200,A80503200,Good,Full Test,Shelf,1,boxed,2020-05-01\nGPU/VGA,,Unknown PCI video card,,,,,,,\n", commit=True)
    assert report["committed"] and report["imported"] == 2
    cpu, gpu = items(client, sort="newest", order="asc")
    assert cpu["inventory_code"] == "HW-000001" and gpu["inventory_code"] == "HW-000002"
    detail = client.get(f"/api/v1/items/{cpu['id']}").json()
    assert (detail["manufacturer"], detail["part_number"], detail["condition"], detail["test_status"]) == ("Intel", "A80503200", "Good", "Full Test")
    assert (detail["location_id"], detail["order"], detail["acquired_on"], detail["notes"]) == (shelf["id"], 1, "2020-05-01", "boxed")
    other = client.get(f"/api/v1/items/{gpu['id']}").json()
    assert (other["condition"], other["test_status"], other["location_id"]) == ("Unknown", "Untested", None)


def test_column_aliases_case_insensitivity_and_unknown_columns(client):
    csv_text = "Category,Name,P/N,Test Status,Condition,Colour,inventory_code\ncpu,Some CPU,PN-1,full test,GOOD,red,HW-000999\n"
    report = upload(client, csv_text, commit=True)
    assert report["imported"] == 1
    assert any("Colour" in w for w in report["warnings"]) and any("inventory_code" in w for w in report["warnings"])
    item = items(client)[0]
    assert (item["model"], item["part_number"], item["test_status"], item["condition"], item["category_name"]) == ("Some CPU", "PN-1", "Full Test", "Good", "CPU")
    assert item["inventory_code"] == "HW-000001"  # the file's code is not reused


def test_utf8_bom_semicolons_and_windows_1252(client):
    bom = ("﻿category;model;notes\nCPU;Pentium;fine\n").encode("utf-8")
    assert upload(client, bom, commit=True)["imported"] == 1
    cp1252 = "category;model\nCPU;Cyrix 6x86 “PR200+” é\n".encode("cp1252")
    report = upload(client, cp1252, commit=True)
    assert report["imported"] == 1 and any("Windows-1252" in w for w in report["warnings"])
    assert any("é" in i["model"] for i in items(client))


def test_row_errors_are_reported_per_line_and_block_the_commit(client):
    text = HEADER + "CPU,,ok,,,,,,,\nNOPE,,bad category,,,,,,,\nCPU,,,,,,,,,\nCPU,,bad status,,,Working,,,,\nCPU,,bad date,,,,,,,31/12/2020\nCPU,,pos without loc,,,,,3,,\n"
    report = upload(client, text, commit=True)
    assert report["blocked"] is True and report["committed"] is False and report["imported"] == 0
    assert (report["total_rows"], report["valid_rows"], report["error_rows"]) == (6, 1, 5)
    by_line = {e["line"]: e["message"] for e in report["errors"]}
    assert "unknown category" in by_line[3] and "model is required" in by_line[4]
    assert "test_status" in by_line[5] and "YYYY-MM-DD" in by_line[6] and "needs a location" in by_line[7]
    assert items(client) == []  # all or nothing


def test_skip_invalid_imports_only_the_good_rows(client):
    text = HEADER + "CPU,,good one,,,,,,,\nNOPE,,bad,,,,,,,\nCPU,,good two,,,,,,,\n"
    report = upload(client, text, commit=True, skip_invalid=True)
    assert report["committed"] and report["imported"] == 2 and report["error_rows"] == 1
    assert sorted(i["model"] for i in items(client)) == ["good one", "good two"]


def test_creating_missing_categories_and_locations(client):
    text = HEADER + "Network Card,3Com,3C905,,,,Workshop > Shelf 2 > Card Box,1,,\nNetwork Card,3Com,3C509,,,,Workshop > Shelf 2 > Card Box,2,,\n"
    preview = upload(client, text, create_categories=True, create_locations=True)
    assert preview["new_categories"] == ["Network Card"] and preview["new_locations"] == ["Workshop > Shelf 2 > Card Box"]
    assert upload(client, text)["error_rows"] == 2  # not allowed without the options
    assert items(client) == []

    report = upload(client, text, commit=True, create_categories=True, create_locations=True)
    assert report["imported"] == 2
    got = items(client, sort="position", location_id=client.get(f"{API}/locations").json()["items"][0]["id"])
    assert [(i["category_name"], i["location_path"], i["order"]) for i in got] == [("Network Card", "Workshop > Shelf 2 > Card Box", 1), ("Network Card", "Workshop > Shelf 2 > Card Box", 2)]
    # The categories and the path exist exactly once.
    assert [c["name"] for c in client.get(f"{API}/categories").json() if c["name"] == "Network Card"] == ["Network Card"]
    assert upload(client, HEADER + "Network Card,,again,,,,Workshop > Shelf 2 > Card Box,3,,\n", commit=True, create_locations=True)["imported"] == 1
    assert len(client.get(f"{API}/locations").json()["items"]) == 1


def test_ambiguous_locations_are_an_error(client, make_location):
    shelf = make_location("Shelf")
    make_location("Box", shelf["id"])
    make_location("Box", shelf["id"])  # duplicate sibling names are allowed...
    report = upload(client, HEADER + "CPU,,x,,,,Shelf > Box,,,\n")
    assert report["error_rows"] == 1 and "ambiguous" in report["errors"][0]["message"]  # ...so a path can be ambiguous


def test_positions_must_be_unique_in_the_file_and_free_in_the_database(client, make_location, make_item):
    box = make_location("Box")
    make_item("holder", location_id=box["id"], order=2)
    text = HEADER + "CPU,,a,,,,Box,1,,\nCPU,,b,,,,Box,1,,\nCPU,,c,,,,Box,2,,\nCPU,,d,,,,Box,3,,\n"
    report = upload(client, text)
    by_line = {e["line"]: e["message"] for e in report["errors"]}
    assert "already used by line 2" in by_line[3]
    assert "already taken by HW-000001" in by_line[4]
    assert 2 not in by_line and 5 not in by_line


def test_file_level_problems(client):
    r = client.post(f"{API}/import/items.csv", files={"file": ("x.csv", b"", "text/csv")})
    assert r.status_code == 422
    r = client.post(f"{API}/import/items.csv", files={"file": ("x.csv", b"manufacturer,notes\nIntel,hi\n", "text/csv")})
    assert r.status_code == 422 and "category" in r.json()["detail"] and "model" in r.json()["detail"]
    big = b"category,model\n" + b"CPU,x\n" * 60_000
    assert client.post(f"{API}/import/items.csv", files={"file": ("x.csv", big, "text/csv")}).status_code == 422


def test_blank_lines_are_ignored_and_the_error_list_is_capped(client):
    ok = upload(client, "category,model\n\nCPU,a\n,,\nCPU,b\n")
    assert ok["total_rows"] == 2
    many = upload(client, "category,model\n" + "NOPE,x\n" * 300)
    assert many["error_rows"] == 300 and len(many["errors"]) == 200 and many["errors_truncated"] is True


def test_export_then_import_round_trips_into_an_empty_inventory(client, make_item, make_location):
    shelf = make_location("Shelf")
    make_item("Pentium", manufacturer="Intel", condition="Good", test_status="POST", test_notes="boots, \"quoted\"", location_id=shelf["id"], order=4, notes="line1\nline2")
    make_item("Unknown PCI video card", category="GPU/VGA")
    exported = client.get(f"{API}/export/items.csv").content
    for item in items(client):
        client.delete(f"{API}/items/{item['id']}")
    report = upload(client, exported, commit=True)
    assert report["imported"] == 2 and report["error_rows"] == 0
    got = {i["model"]: i for i in items(client)}
    assert got["Pentium"]["order"] == 4 and got["Pentium"]["location_path"] == "Shelf"
    detail = client.get(f"{API}/items/{got['Pentium']['id']}").json()
    assert detail["test_notes"] == 'boots, "quoted"' and detail["notes"] == "line1\nline2"


def test_template_download_is_itself_importable(client, make_location):
    template = client.get(f"{API}/import/template.csv")
    assert template.status_code == 200 and template.text.startswith("category,manufacturer,model")
    report = upload(client, template.content, create_locations=True)
    assert report["error_rows"] == 0 and report["valid_rows"] == 2


def test_a_large_file_imports_in_one_transaction(client):
    text = "category,model,manufacturer\n" + "".join(f"CPU,Part {i},Acme\n" for i in range(5000))
    report = upload(client, text, commit=True)
    assert report["imported"] == 5000
    assert client.get(f"{API}/items", params={"with_total": True, "limit": 1}).json()["total"] == 5000


def test_formula_protection_from_the_export_is_undone(client, make_item):
    make_item("=HYPERLINK(\"http://evil\")", manufacturer="@x")
    exported = client.get(f"{API}/export/items.csv").content
    assert b"'=HYPERLINK" in exported
    for item in items(client):
        client.delete(f"{API}/items/{item['id']}")
    upload(client, exported, commit=True)
    got = client.get(f"{API}/items/{items(client)[0]['id']}").json()
    assert got["model"] == '=HYPERLINK("http://evil")' and got["manufacturer"] == "@x"


def test_malformed_csv_is_a_clear_error_not_a_crash(client):
    huge = "category,model,notes\nCPU,x," + "a" * 200_000 + "\n"
    r = client.post(f"{API}/import/items.csv", files={"file": ("x.csv", huge.encode(), "text/csv")})
    assert r.status_code == 422 and "not valid CSV" in r.json()["detail"] and "line" in r.json()["detail"]
