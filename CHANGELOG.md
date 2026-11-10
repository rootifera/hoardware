# Changelog

## 1.1.0

Your own collection, not only PC hardware.

- First-run choice between the standard PC categories and a custom collection with starter sets (music gear, trading cards, electronics, empty), with your own item code prefix.
- Per-category control of the standard fields: hide, rename, and rename or hide condition and test-status values.
- **Track as stock**: counted items with take out / add, history, low-stock warnings and filter.
- **Barcode labels** (Code 128), scan-to-find with a USB scanner, an optional original barcode per item, labels for boxes and shelves, and camera scanning on a phone.
- **Item status** (in collection, installed in a build, lent, sold, scrapped, wishlist), builds with their parts, and a history of every move and status change.
- Price and source, splitting stock across locations.
- Filter and sort by a spec with units understood; bulk set a status or a spec on many items.
- PCI ID lookup for sound, network and other PCI cards.
- A suggestion picked in Quick add is saved as a *candidate*, to be confirmed on the item page.
- Bulk Export and Delete, sticky bulk bar, files in Quick add, version display and update check.

Upgrading from 1.0: run `./deploy.sh`; the database migrates itself (revisions 0013 to 0020) and existing items keep working. Take a backup first.
