#!/usr/bin/env python3
"""Build local clinical snapshots and the import archive from operator-supplied data."""
import argparse
import csv
import json
import re
from collections import Counter
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
PREIMPLANT_PHASES = {
    "historical_noninvasive_calendar_unknown",
    "preimplant_discussion_noninvasive",
}


def report_sections(summary):
    """Keep the supplied clinical passages and remove publication/export headings."""
    paragraphs = [block.strip() for block in re.split(r"\n\s*\n", summary) if block.strip()]
    headings = {
        "术前诊断", "入院诊断", "诊断", "主诉", "现病史", "既往史", "家族史",
        "出生史", "生长发育史", "个人史", "查体", "发作症状学", "致痫灶",
        "总结/小结", "定位假设", "定位", "定侧", "辅助检查",
    }
    sections = []
    has_history = any(block.splitlines()[0] == "现病史" for block in paragraphs)
    for block in paragraphs:
        lines = block.splitlines()
        heading = lines[0]
        if heading in headings and len(lines) > 1:
            sections.append((heading.replace("总结/小结", "临床小结"), "\n".join(lines[1:]).strip()))
        elif block.startswith("EEG Vid") and not has_history:
            clean = re.sub(r"^EEG Vid.*?EEG SEEG Surg\. Plan\.\s*", "", block)
            clean = re.sub(r"\[calendar (?:date|year) removed\]", "", clean)
            sections.append(("发作与病史记录", clean))
        elif block.startswith("病史症状学 EEG"):
            sections.append(("脑电与发作记录", block))
    return sections


def read_table(dataset, name):
    with (dataset / "metadata" / name).open(encoding="utf-8", newline="") as stream:
        return list(csv.DictReader(stream, delimiter="\t"))


def build(dataset, supplemental_file, associations_file):
    associations = json.loads(associations_file.read_text(encoding="utf-8"))
    clinical = {row["subject_id"]: row for row in read_table(dataset, "clinical.tsv")}
    participants = {row["subject_id"]: row for row in read_table(dataset, "participants.tsv")}
    imaging = read_table(dataset, "imaging.tsv")
    supplemental = json.loads(supplemental_file.read_text(encoding="utf-8"))
    recovered = json.loads((ROOT / "data/clinical/legacy_case_report_notes.json").read_text(encoding="utf-8"))
    cases = {}
    shared = {}
    for patient_id, link in associations["cases"].items():
        subject_id = link["subject_id"]
        if subject_id is not None:
            shared.setdefault(subject_id, []).append(patient_id)
        case = {
            "patient_id": patient_id, "subject_id": subject_id,
            "diagnosis": "", "history": "", "sex": "", "age": None,
            "report_title": "术前临床评估报告", "report_text": "", "sources": [], "imaging_summary": "",
            "record_counts": {}, "mapping_status": "linked",
        }
        if link.get("derived_from_patient_id"):
            case["derived_from_patient_id"] = link["derived_from_patient_id"]
        if subject_id is not None:
            row = clinical[subject_id]
            participant = participants[subject_id]
            summary = (dataset / row["clinical_text_path"]).read_text(encoding="utf-8").strip()
            case.update(
                diagnosis=row["diagnosis_zh"], history=row["clinical_history_zh"],
                sex={"M": "男", "F": "女"}.get(row["sex"], row["sex"]),
                age=int(row["age_years"]) if row["age_years"] else None,
                mapping_status="linked_derived" if link.get("derived_from_patient_id") else "linked",
            )
            sections = report_sections(summary)
            preoperative_diagnosis = next((text for title, text in sections if title == "术前诊断"), None)
            if preoperative_diagnosis:
                case["diagnosis"] = preoperative_diagnosis
            brief = f"诊断：{case['diagnosis']}\n病史：{case['history']}\n记录年龄：{case['age']}岁；性别：{case['sex']}。"
            clinical_text = "\n\n".join(f"【{title}】\n{text}" for title, text in sections)
            sources = [
                {"id": f"{subject_id}-clinical-tsv", "title": "临床摘要", "text": brief},
                {"id": f"{subject_id}-clinical-summary", "title": "病史与临床评估", "text": clinical_text or case["history"]},
            ]
            for evidence in supplemental:
                if evidence["subject_id"] == subject_id and evidence["source_phase"] in PREIMPLANT_PHASES:
                    sources.append({
                        "id": evidence["evidence_id"],
                        "title": f"临床讨论记录 · 第{evidence['source_page']}页",
                        "text": evidence["text_zh"].strip(),
                    })
            if subject_id == recovered["subject_id"]:
                for evidence in recovered["sources"]:
                    if evidence["source_phase"] in PREIMPLANT_PHASES:
                        sources.append({"id": evidence["id"], "title": evidence["title"], "text": evidence["text_zh"]})
            case["sources"] = sources
            case["report_text"] = "\n\n".join(f"【{source['title']}】\n{source['text']}" for source in sources)
            case["record_counts"] = {
                "models": int(participant["n_models"]),
                "imaging_series": int(participant["n_imaging_series"]),
                "dicom_instances": int(participant["n_dicom_instances"]),
                "electrodes": int(participant["n_electrodes"]),
            }
            modalities = Counter(item["modality"] for item in imaging if item["subject_id"] == subject_id)
            case["imaging_summary"] = "、".join(f"{modality} {count}组" for modality, count in sorted(modalities.items()))
            case["imaging_summary"] = f"影像资料：{case['imaging_summary']}。"
        cases[patient_id] = case
        package = ROOT / patient_id
        package.mkdir(exist_ok=True)
        (package / "clinical_report.json").write_text(json.dumps(case, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (package / "病例报告.txt").write_text(f"{case['report_title']}\n病例：{patient_id}\n\n{case['report_text']}\n", encoding="utf-8")
        info_path = package / "patient_info.json"
        info = json.loads(info_path.read_text(encoding="utf-8"))
        info["clinical_report"] = "clinical_report.json"
        info_path.write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    output = ROOT / "data/clinical/cases.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({
        "release": associations["release"],
        "association_sources": associations.get("association_sources", []),
        "shared_clinical_cases": {subject: ids for subject, ids in shared.items() if len(ids) > 1},
        "cases": cases,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    exports = ROOT / "exports"
    exports.mkdir(exist_ok=True)
    with ZipFile(exports / "SEEG-v3-病例数据包.zip", "w", compression=ZIP_DEFLATED) as archive:
        for patient_id in cases:
            for name in ("patient_info.json", "clinical_report.json", "病例报告.txt"):
                file = ROOT / patient_id / name
                archive.write(file, file.relative_to(ROOT))
    print(json.dumps({key: {"subject_id": case["subject_id"], "mapping_status": case["mapping_status"], "sources": len(case["sources"])} for key, case in cases.items()}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True, help="Local dataset directory containing metadata/ and subjects/")
    parser.add_argument("--supplemental", type=Path, required=True, help="Local JSON array of supplemental clinical records")
    parser.add_argument("--associations", type=Path, default=ROOT / "data/clinical/cases.json",
                        help="Private JSON with a release label and a cases object keyed by demo ID")
    args = parser.parse_args()
    build(args.dataset, args.supplemental, args.associations)
