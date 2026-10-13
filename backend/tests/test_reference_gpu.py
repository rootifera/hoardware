import csv

import pytest

from app.reference.gpuspecs import GpuSpecsAdapter
from app.reference.runner import run_import

API = "/api/v1"

HEADER = [
    "Brand", "Name", "Graphics Processor__GPU Name", "Memory__Memory Size", "Memory__Memory Type", "Memory__Memory Bus",
    "Graphics Card__Bus Interface", "Mobile Graphics__Bus Interface", "Clock Speeds__GPU Clock", "Clock Speeds__Memory Clock",
    "Graphics Card__Release Date", "Board Design__Board Number", "Board Design__Outputs", "source_file",
]


def gpu_row(**values):
    return [values.get(h, "") for h in HEADER]


@pytest.fixture
def dataset(tmp_path):
    rows = [
        gpu_row(**{"Brand": "NVIDIA", "Name": "Riva TNT2 Ultra", "Graphics Processor__GPU Name": "NV5", "Memory__Memory Size": "32 MB",
                   "Memory__Memory Type": "SDR", "Memory__Memory Bus": "128 bit", "Graphics Card__Bus Interface": "AGP 4x",
                   "Clock Speeds__GPU Clock": "150 MHz", "Graphics Card__Release Date": "Mar 15th, 1999"}),
        gpu_row(**{"Brand": "3dfx", "Name": "Voodoo3 3000 AGP", "Graphics Processor__GPU Name": "Avenger", "Memory__Memory Size": "16 MB",
                   "Memory__Memory Type": "SDR", "Graphics Card__Bus Interface": "AGP 2x", "Clock Speeds__GPU Clock": "166 MHz"}),
        gpu_row(**{"Brand": "3dfx", "Name": "Voodoo3 3000 PCI", "Graphics Processor__GPU Name": "Avenger", "Memory__Memory Size": "16 MB",
                   "Graphics Card__Bus Interface": "PCI"}),
        gpu_row(**{"Brand": "ATI", "Name": "3D Rage PRO AGP", "Graphics Processor__GPU Name": "Rage PRO", "Memory__Memory Size": "2 MB",
                   "Mobile Graphics__Bus Interface": "AGP 1x", "Board Design__Board Number": "109-49800-10", "Board Design__Outputs": "unknown"}),
        gpu_row(**{"Brand": "SiS", "Name": "315 Pro", "Graphics Processor__GPU Name": "Mirage", "Memory__Memory Size": "64 MB"}),
        gpu_row(**{"Brand": "ATI", "Name": "Rage Fury", "Graphics Processor__GPU Name": "Rage 128 PRO", "Memory__Memory Size": "32 MB"}),
        gpu_row(**{"Brand": "ATI", "Name": "Rage Fury", "Graphics Processor__GPU Name": "Rage 128 PRO", "Memory__Memory Size": "32 MB"}),  # exact dup
        gpu_row(**{"Brand": "", "Name": "No brand"}),
    ]
    with open(tmp_path / "gpu_test.csv", "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(HEADER)
        w.writerows(rows)
    return tmp_path


def load(db, dataset):
    return run_import(db, GpuSpecsAdapter(), dataset)


def test_adapter_reads_curated_specs_and_reports_problems(dataset):
    items = list(GpuSpecsAdapter().read(dataset))
    recs = {r.upstream_id: r for r in items if hasattr(r, "upstream_id")}
    tnt = recs["nvidia|riva tnt2 ultra|1"]
    assert tnt.kind == "gpu" and tnt.manufacturer == "NVIDIA" and tnt.family == "NV5"
    assert tnt.specs["Chipset"] == "Riva TNT2 Ultra" and tnt.specs["Chipset maker"] == "NVIDIA" and tnt.specs["GPU chip"] == "NV5"
    assert tnt.specs["Memory size"] == "32 MB" and tnt.specs["Bus"] == "AGP 4x" and tnt.specs["Released"] == "Mar 15th, 1999"
    rage = recs["ati|3d rage pro agp|1"]
    assert rage.specs["Bus"] == "AGP 1x"  # from the mobile column when the desktop one is empty
    assert rage.part_number == "109-49800-10"
    assert "Outputs" not in rage.specs  # "unknown" is not a value
    issues = [i for i in items if hasattr(i, "level")]
    assert sorted(i.level for i in issues) == ["error", "skipped"]  # no brand; exact duplicate
    assert len(recs) == 6


def test_import_is_repeatable(db, dataset):
    first = load(db, dataset)
    assert first.added == 6
    again = load(db, dataset)
    assert (again.added, again.changed, again.unchanged) == (0, 0, 6)


def test_suggestions_by_name_prefer_whole_words_and_board_number_is_exact(client, db, dataset):
    load(db, dataset)
    r = client.get(f"{API}/reference-suggestions", params={"q": "rage pro", "kind": "gpu"}).json()
    names = [c["reference"]["model"] for c in r]
    assert names[0] == "3D Rage PRO AGP" and "315 Pro" not in names[:1]
    r = client.get(f"{API}/reference-suggestions", params={"q": "tnt2 ultra", "kind": "gpu"}).json()
    assert [c["reference"]["display_name"] for c in r] == ["Riva TNT2 Ultra"]
    assert r[0]["reference"]["spec_line"] == "NV5 · 32 MB SDR · AGP 4x · 150 MHz"
    r = client.get(f"{API}/reference-suggestions", params={"q": "109-49800-10"}).json()
    assert r[0]["match_type"] == "exact" and r[0]["reference"]["kind"] == "gpu"
    # A kind keeps CPU records out of graphics searches.
    assert client.get(f"{API}/reference-suggestions", params={"q": "tnt2 ultra", "kind": "cpu"}).json() == []


def test_picked_card_fills_chipset_columns_specs_and_inventory_line(client, db, dataset, cats):
    load(db, dataset)
    ref_id = client.get(f"{API}/reference-suggestions", params={"q": "tnt2 ultra", "kind": "gpu"}).json()[0]["reference"]["id"]
    gpu = next(c for c in client.get(f"{API}/categories").json() if c["name"] == "GPU/VGA")
    item = client.post(f"{API}/items", json={"category_id": gpu["id"], "model": "Diamond Viper V770 Ultra", "manufacturer": "Diamond", "reference_model_id": ref_id}).json()
    assert item["manufacturer"] == "Diamond" and item["model"] == "Diamond Viper V770 Ultra"  # the user's own words stay
    assert item["chipset_manufacturer"] == "NVIDIA" and item["chipset"] == "Riva TNT2 Ultra"
    attrs = item["attributes"]
    assert attrs["Memory size"] == "32 MB" and attrs["GPU chip"] == "NV5" and attrs["Source"] == "GPUs-Specs"
    assert "Chipset" not in attrs and "Family" not in attrs
    assert item["spec_line"] == "Riva TNT2 Ultra · 32 MB SDR · AGP 4x · 150 MHz"
    listed = client.get(f"{API}/items", params={"q": "diamond"}).json()["items"][0]
    assert listed["spec_line"] == item["spec_line"]


def test_user_values_win_and_link_fills_only_empty_columns(client, db, dataset):
    load(db, dataset)
    ref_id = client.get(f"{API}/reference-suggestions", params={"q": "voodoo3 3000 agp", "kind": "gpu"}).json()[0]["reference"]["id"]
    gpu = next(c for c in client.get(f"{API}/categories").json() if c["name"] == "GPU/VGA")
    item = client.post(f"{API}/items", json={"category_id": gpu["id"], "model": "Voodoo3", "chipset": "My own chipset", "attributes": {"Memory size": "8 MB"}}).json()
    linked = client.post(f"{API}/items/{item['id']}/reference-match", json={"reference_model_id": ref_id, "confidence": "candidate"}).json()
    assert linked["chipset"] == "My own chipset" and linked["chipset_manufacturer"] == "3dfx"
    assert linked["attributes"]["Memory size"] == "8 MB" and linked["attributes"]["GPU chip"] == "Avenger"


def test_item_candidates_use_the_category_kind(client, db, dataset):
    load(db, dataset)
    gpu = next(c for c in client.get(f"{API}/categories").json() if c["name"] == "GPU/VGA")
    item = client.post(f"{API}/items", json={"category_id": gpu["id"], "model": "Voodoo3 3000"}).json()
    names = [c["reference"]["model"] for c in client.get(f"{API}/items/{item['id']}/reference-candidates").json()]
    assert names == ["Voodoo3 3000 AGP", "Voodoo3 3000 PCI"]


def test_candidates_for_a_card_look_up_its_chipset_not_its_own_name(client, db, dataset):
    load(db, dataset)
    gpu = next(c for c in client.get(f"{API}/categories").json() if c["name"] == "GPU/VGA")
    item = client.post(f"{API}/items", json={"category_id": gpu["id"], "model": "Viper V770 Ultra", "manufacturer": "Diamond", "chipset": "TNT2 Ultra"}).json()
    names = [c["reference"]["model"] for c in client.get(f"{API}/items/{item['id']}/reference-candidates").json()]
    assert names == ["Riva TNT2 Ultra"]
