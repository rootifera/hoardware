import pytest

from app.reference.pciids import PciIdsAdapter
from app.reference.runner import run_import

API = "/api/v1"

PCI_IDS = """\
# List of PCI ID's
#
#	Version: 2024.05.01
#	Date:    2024-05-01 03:15:02
8086  Intel Corporation
\t1237  440FX - 82441FX PMC [Natoma]
\t7000  82371SB PIIX3 ISA [Natoma/Triton II]
\t\t1af4 1100  Qemu virtual machine
1102  Creative Labs
\t0002  EMU10k1 [Sound Blaster Live! Series]
\t7002  SB Live! Game Port
10ec  Realtek Semiconductor Co., Ltd.
\t8139  RTL-8100/8101L/8139 PCI Fast Ethernet Adapter
C 00  Unclassified device
\t00  Non-VGA unclassified device
"""


@pytest.fixture
def dataset(tmp_path):
    (tmp_path / "pci.ids").write_text(PCI_IDS, encoding="utf-8")
    return tmp_path


def test_adapter_reads_vendors_and_devices_but_not_subsystems_or_classes(dataset):
    records = [r for r in PciIdsAdapter().read(dataset) if hasattr(r, "upstream_id")]
    assert [r.upstream_id for r in records] == ["8086:1237", "8086:7000", "1102:0002", "1102:7002", "10ec:8139"]
    live = next(r for r in records if r.upstream_id == "1102:0002")
    assert live.kind == "pci" and live.manufacturer == "Creative Labs" and live.model.startswith("EMU10k1")
    assert live.part_number == "1102:0002" and live.specs["PCI ID"] == "1102:0002"
    assert PciIdsAdapter().source_version(dataset) == "2024.05.01"


def test_a_sound_card_is_found_by_its_pci_id_or_chip_name(client, db, dataset):
    assert run_import(db, PciIdsAdapter(), dataset).added == 5
    by_id = client.get(f"{API}/reference-suggestions", params={"q": "1102:0002", "kind": "pci"}).json()
    assert by_id and by_id[0]["match_type"] == "exact" and by_id[0]["reference"]["manufacturer"] == "Creative Labs"
    assert by_id[0]["reference"]["spec_line"] == "1102:0002"
    by_name = client.get(f"{API}/reference-suggestions", params={"q": "emu10k1", "kind": "pci"}).json()
    assert [c["reference"]["part_number"] for c in by_name] == ["1102:0002"]


def test_sound_and_network_categories_use_the_pci_list(client, db, dataset, make_item):
    run_import(db, PciIdsAdapter(), dataset)
    item = make_item("Sound Blaster Live!", category="Sound Card", part_number="1102:0002")
    found = client.get(f"{API}/items/{item['id']}/reference-candidates").json()
    assert found and found[0]["reference"]["kind"] == "pci"
