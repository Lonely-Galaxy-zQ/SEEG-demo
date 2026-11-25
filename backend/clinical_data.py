"""Anonymous clinical snapshots linked to the eight existing demo entries."""
import copy
import json
from functools import lru_cache
from pathlib import Path

from .data_loader import PATIENT_DATA_MAP

CLINICAL_FILE = Path(__file__).resolve().parents[1] / "data/clinical/cases.json"


@lru_cache(maxsize=1)
def _cases():
    root = Path(__file__).resolve().parents[1]
    return {
        patient_id: json.loads((root / patient_id / "clinical_report.json").read_text(encoding="utf-8"))
        for patient_id in PATIENT_DATA_MAP
    }


def get_clinical_case(patient_id: str) -> dict:
    """Return a copy so request-specific edits cannot alter the stored case."""
    patient = PATIENT_DATA_MAP[patient_id]
    case = copy.deepcopy(_cases()[patient_id])
    case["regions"] = [
        {"electrodeName": electrode, "regionName": Path(filename).stem}
        for electrode, filename in patient["target_map"].items()
    ]
    return case


def get_case_catalog() -> list:
    """List the original base plans and actually saved alternative counts."""
    catalog = []
    for patient_id, patient in PATIENT_DATA_MAP.items():
        base = json.loads(Path(patient["result_file"]).read_text(encoding="utf-8"))
        base_count = len(base)
        counts = {base_count}
        for plan in (Path(patient["stl_dir"]) / "edits").glob("plan_*.json"):
            data = json.loads(plan.read_text(encoding="utf-8"))
            electrodes = data.get("electrodes", []) if isinstance(data, dict) else data
            if electrodes:
                counts.add(len(electrodes))
        case = _cases()[patient_id]
        catalog.append({
            "patient_id": patient_id,
            "base_count": base_count,
            "available_plan_counts": sorted(counts),
            "diagnosis": case["diagnosis"],
            "subject_id": case["subject_id"],
            "mapping_status": case["mapping_status"],
        })
    return catalog
