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


class PhotoRole(StrEnum):
    FRONT = "front"
    BACK = "back"
    LABEL = "label"
    CHIPSET = "chipset"
    OTHER = "other"


def sql_in(enum: type[StrEnum]) -> str:
    return ", ".join(f"'{m.value}'" for m in enum)
