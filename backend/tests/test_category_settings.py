API = "/api/v1"


def category(client, name="Other"):
    return next(c for c in client.get(f"{API}/categories").json() if c["name"] == name)


def test_a_category_starts_with_no_overrides(client):
    assert category(client)["settings"] == {"core": {}, "values": {}, "hidden": {}}


def test_settings_can_be_saved_and_read_back(client):
    cat = category(client)
    settings = {
        "core": {"manufacturer": {"label": "Brand"}, "part_number": {"show": False}, "test_status": {"show": False}, "model": {"label": "Card name"}},
        "values": {"condition": {"Excellent": "Near mint", "Fair": "Played"}},
    }
    r = client.patch(f"{API}/categories/{cat['id']}", json={"settings": settings})
    assert r.status_code == 200, r.text
    got = category(client)["settings"]
    assert got["core"]["manufacturer"]["label"] == "Brand"
    assert got["core"]["part_number"]["show"] is False
    assert got["core"]["model"]["label"] == "Card name"
    assert got["values"]["condition"] == {"Excellent": "Near mint", "Fair": "Played"}
    # Other edits keep the settings, and the settings edit keeps the fields.
    client.patch(f"{API}/categories/{cat['id']}", json={"name": "Cards"})
    assert category(client, "Cards")["settings"]["core"]["manufacturer"]["label"] == "Brand"


def test_hidden_fields_never_block_creating_items(client, cats):
    client.patch(f"{API}/categories/{cats['CPU']}", json={"settings": {"core": {"manufacturer": {"show": False}, "condition": {"show": False}}}})
    r = client.post(f"{API}/items", json={"category_id": cats["CPU"], "model": "Hidden things"})
    assert r.status_code == 201 and r.json()["condition"] == "Unknown"  # the defaults are still stored


def test_validation(client):
    cat = category(client)
    url = f"{API}/categories/{cat['id']}"
    bad = [
        {"core": {"model": {"show": False}}},  # the model identifies an item
        {"core": {"colour": {"show": False}}},  # not a standard field
        {"core": {"manufacturer": {"label": ""}}},
        {"core": {"manufacturer": {"label": "x" * 41}}},
        {"values": {"condition": {"Pristine": "Mint"}}},  # not a stored condition
        {"values": {"manufacturer": {"A": "B"}}},  # not a field with values
    ]
    for settings in bad:
        assert client.patch(url, json={"settings": settings}).status_code == 422, settings
    assert client.patch(url, json={"settings": None}).status_code == 422  # cannot be null
    # Creating with settings works too.
    r = client.post(f"{API}/categories", json={"name": "Vinyl", "settings": {"core": {"test_status": {"label": "Plays?"}}}})
    assert r.status_code == 201 and r.json()["settings"]["core"]["test_status"]["label"] == "Plays?"


def test_values_can_be_hidden_for_a_category(client):
    cat = category(client)
    url = f"{API}/categories/{cat['id']}"
    ok = client.patch(url, json={"settings": {"hidden": {"condition": ["Excellent", "Poor"], "test_status": ["POST"]}, "values": {"condition": {"Good": "Salvaged"}}}})
    assert ok.status_code == 200, ok.text
    got = category(client)["settings"]
    assert got["hidden"] == {"condition": ["Excellent", "Poor"], "test_status": ["POST"]} and got["values"]["condition"] == {"Good": "Salvaged"}
    everything = ["Unknown", "New / Sealed", "Excellent", "Good", "Fair", "Poor", "Damaged"]
    for bad in (
        {"hidden": {"condition": everything}},  # something has to stay available
        {"hidden": {"condition": ["Pristine"]}},
        {"hidden": {"condition": ["Fair", "Fair"]}},
        {"hidden": {"manufacturer": ["x"]}},
    ):
        assert client.patch(url, json={"settings": bad}).status_code == 422, bad
