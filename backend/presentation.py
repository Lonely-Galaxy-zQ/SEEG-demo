"""Read the hand-authored walkthrough for the existing demo target maps."""
import json
from pathlib import Path

from .data_loader import PATIENT_DATA_MAP

PRESENTATION_FILE = Path(__file__).resolve().parents[1] / "data/presentation/cases.json"


def get_presentation(patient_id: str) -> dict:
    """Load editable presentation text and check its configured target keys."""
    target_map = PATIENT_DATA_MAP[patient_id]["target_map"]
    cases = json.loads(PRESENTATION_FILE.read_text(encoding="utf-8"))
    case = cases[patient_id]
    configured = set()
    for region in case["regions"]:
        key = region["electrodeName"]
        if key not in target_map:
            raise ValueError(f"{patient_id}: unknown presentation target {key!r}")
        if region["regionName"] != Path(target_map[key]).stem:
            raise ValueError(f"{patient_id}: presentation target name differs for {key!r}")
        configured.add(key)
    if configured != set(target_map):
        raise ValueError(f"{patient_id}: presentation regions must cover the existing target map")

    highlighted = set()
    for step in case["steps"]:
        for key in step["region_keys"]:
            if key not in configured:
                raise ValueError(f"{patient_id}: unknown step target {key!r}")
        if step["action"] == "highlight":
            highlighted.update(step["region_keys"])
    if configured - highlighted:
        raise ValueError(f"{patient_id}: targets missing from highlight steps: {sorted(configured - highlighted)}")
    return case
