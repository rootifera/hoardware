from enum import StrEnum


class Condition(StrEnum):
    UNKNOWN = "Unknown"
    NEW = "New / Sealed"
    EXCELLENT = "Excellent"
    GOOD = "Good"
    FAIR = "Fair"
    POOR = "Poor"
    DAMAGED = "Damaged"


class TestStatus(StrEnum):
    __test__ = False  # not a pytest class

    UNKNOWN = "Unknown"
    UNTESTED = "Untested"
    POST = "POST"
    FULL_TEST = "Full Test"
    DEAD = "Dead"


class IdentificationConfidence(StrEnum):
    UNIDENTIFIED = "unidentified"
    CANDIDATE = "candidate"
    CONFIRMED = "confirmed"


class ItemStatus(StrEnum):
    IN_COLLECTION = "in_collection"
    INSTALLED = "installed"  # sits inside another item (a build)
    LENT = "lent"
    SOLD = "sold"
    SCRAPPED = "scrapped"
    WANTED = "wanted"  # on the wishlist: not owned yet


# What counts as "what I have" when no status filter is chosen.
OWNED_STATUSES = (ItemStatus.IN_COLLECTION, ItemStatus.INSTALLED, ItemStatus.LENT)
# These have no place on a shelf: their location is cleared.
GONE_STATUSES = (ItemStatus.SOLD, ItemStatus.SCRAPPED, ItemStatus.WANTED)


class PhotoRole(StrEnum):
    FRONT = "front"
    BACK = "back"
    LABEL = "label"
    CHIPSET = "chipset"
    OTHER = "other"


class FileKind(StrEnum):
    MANUAL = "manual"
    DRIVER = "driver"
    FIRMWARE = "firmware"
    TOOL = "tool"
    DATASHEET = "datasheet"
    OTHER = "other"


def sql_in(enum: type[StrEnum]) -> str:
    return ", ".join(f"'{m.value}'" for m in enum)
