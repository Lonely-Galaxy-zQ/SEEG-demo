"""数据加载核心模块：STL 简化 + evaluation_results.json 解析"""
import base64
import json
import math
import re
import logging
import datetime
from pathlib import Path
from typing import Dict, List, Optional, Generator, Tuple

import trimesh
import numpy as np

logger = logging.getLogger(__name__)
PROJECT_ROOT = Path(__file__).resolve().parents[1]


def load_patient_map() -> dict:
    """Resolve the local scene paths and electrode targets from the presentation data."""
    presentation = PROJECT_ROOT / "data/presentation/cases.json"
    if not presentation.is_file():
        return {}

    cases = json.loads(presentation.read_text(encoding="utf-8"))
    patients = {}
    for patient_id, case in cases.items():
        index = int(patient_id.removeprefix("Patient_"))
        scene_dir = PROJECT_ROOT / "data" / f"patient_{index}"
        patients[patient_id] = {
            "stl_dir": str(scene_dir),
            "result_file": str(scene_dir / "evaluation_results.json"),
            "target_map": {
                region["electrodeName"]: region["regionName"] + ".stl"
                for region in case["regions"]
            },
        }
    return patients


PATIENT_DATA_MAP = load_patient_map()

# ============================================================
# STL 文件名映射（支持中英文，按优先级尝试）
# ============================================================
STL_NAME_PATTERNS = {
    "skull":       ["颅骨1.stl", "颅骨.stl", "skull.stl"],
    "vessel":      ["血管.stl", "vessel.stl"],
    "brainstem":   ["脑干.stl", "brainstem.stl"],
    "brain_left":  ["左大脑.stl", "brain_left.stl"],
    "brain_right": ["右大脑.stl", "brain_right.stl"],
}

# ============================================================
# STL 简化目标面数（仅 >2MB 的文件才简化）
# ============================================================
STL_SIMPLIFY_TARGETS = {
    "skull":       50000,
    "vessel":      40000,
    "brainstem":   15000,
    "brain_left":  20000,
    "brain_right": 20000,
}

# 靶点脑区简化：所有 >2MB 的靶点脑区统一简化到 15000 面
TARGET_SIMPLIFY_FACE_COUNT = 15000

SIZE_THRESHOLD = 2 * 1024 * 1024  # 2MB

# 模块级缓存（按 patient_id 存储）
_scene_cache: Dict[str, dict] = {}


def find_stl_file(stl_dir: str, structure_name: str) -> Optional[str]:
    """根据结构名在目录中查找对应的 STL 文件"""
    patterns = STL_NAME_PATTERNS.get(structure_name, [])
    for pattern in patterns:
        path = Path(stl_dir) / pattern
        if path.exists():
            return str(path)
    return None


def load_stl_as_base64(path: str, structure_name: str) -> str:
    """加载 STL 文件，必要时简化，返回 base64 编码字符串"""
    file_size = Path(path).stat().st_size

    # 确定简化目标面数：主结构查表，靶点脑区统一使用 TARGET_SIMPLIFY_FACE_COUNT
    target_faces = STL_SIMPLIFY_TARGETS.get(structure_name)
    if target_faces is None and structure_name.startswith("target_"):
        target_faces = TARGET_SIMPLIFY_FACE_COUNT

    if file_size > SIZE_THRESHOLD and target_faces is not None:
        logger.info(f"简化 {structure_name}: {file_size/1024/1024:.1f}MB → {target_faces} 面")
        mesh = trimesh.load(path)
        # 处理 trimesh.Scene（多几何体合并）
        if isinstance(mesh, trimesh.Scene):
            mesh = trimesh.util.concatenate([g for g in mesh.geometry.values()])
        try:
            if hasattr(mesh, 'faces') and len(mesh.faces) > target_faces:
                original_faces = len(mesh.faces)
                # 关键：必须用 face_count 关键字参数，否则会被解释为 target_reduction（0~1）
                mesh = mesh.simplify_quadric_decimation(face_count=target_faces)
                logger.info(f"  {structure_name}: {original_faces} → {len(mesh.faces)} 面")
        except Exception as e:
            logger.warning(f"  简化 {structure_name} 失败，保持原始: {e}")
        stl_bytes = mesh.export(file_type='stl')
    else:
        with open(path, 'rb') as f:
            stl_bytes = f.read()

    return base64.b64encode(stl_bytes).decode('utf-8')


def load_anatomy_with_progress(stl_dir: str) -> Generator[Tuple[str, str, int], None, None]:
    """
    逐个加载解剖结构 STL，yield (结构名, base64字符串, 当前序号)。
    用于 SSE 进度推送。
    """
    structures = list(STL_NAME_PATTERNS.keys())
    for i, name in enumerate(structures):
        path = find_stl_file(stl_dir, name)
        if path is None:
            logger.warning(f"未找到 {name} 的 STL 文件，跳过")
            yield (name, "", i + 1)
            continue
        b64 = load_stl_as_base64(path, name)
        yield (name, b64, i + 1)


def load_target_regions_with_progress(
    stl_dir: str, electrodes: List[dict], target_map: Dict[str, str]
) -> Generator[Tuple[str, str, str, int], None, None]:
    """
    逐个加载靶点脑区 STL，yield (电极名, 脑区名, base64字符串, 当前序号)。
    target_map: 电极名 → 靶点脑区 STL 文件名 的映射（按病人区分）。
    """
    target_dir = Path(stl_dir) / "靶点脑区"
    total = len(electrodes)
    for i, elec in enumerate(electrodes):
        elec_name = elec['name'] if isinstance(elec, dict) else elec.name
        stl_filename = target_map.get(elec_name)
        if not stl_filename:
            logger.warning(f"电极 {elec_name} 无靶点脑区映射，跳过")
            yield (elec_name, "", "", i + 1)
            continue

        stl_path = target_dir / stl_filename
        if not stl_path.exists():
            logger.warning(f"靶点脑区文件不存在: {stl_path}")
            yield (elec_name, "", "", i + 1)
            continue

        # 脑区中文名 = 文件名去掉 .stl 后缀
        region_name = stl_filename.replace('.stl', '')
        b64 = load_stl_as_base64(str(stl_path), f"target_{elec_name}")
        logger.info(f"靶点脑区加载完成: {elec_name} → {region_name}")
        yield (elec_name, region_name, b64, i + 1)


def parse_evaluation_results(result_file: str) -> List[dict]:
    """
    解析 evaluation_results.json，提取我们算法的规划结果。

    关键字段映射：
    - my_implant_endpoint → implant_endpoint
    - planned_entry_point → entry_point（注意：原始字段无 my_ 前缀）
    - my_direction → direction
    - my_coverage → metrics.coverage
    - my_min_sdf_vessel → metrics.vessel_margin（mesh 值全为 Infinity 不可用）
    - my_min_sdf_brainstem → metrics.brainstem_margin
    - path_length：从 entry_point 到 implant_endpoint 的欧氏距离（原始 JSON 无此字段）
    """
    with open(result_file, 'r') as f:
        content = f.read()

    # JSON 标准不支持 Infinity，用 999.0 替换后解析
    content = re.sub(r'\bInfinity\b', '999.0', content)
    data = json.loads(content)

    electrodes = []
    for e in data:
        ep = e['planned_entry_point']
        ie = e['my_implant_endpoint']
        # 计算路径长度（原始 JSON 中无此字段）
        path_length = math.sqrt(sum((a - b) ** 2 for a, b in zip(ep, ie)))

        # 安全边距：优先用真实 mesh 距离，保底机制兜底
        vessel_mesh = e.get('my_min_mesh_distance_vessel', 999.0)
        brainstem_mesh = e.get('my_min_mesh_distance_brainstem', 999.0)

        # 保底机制：mesh 距离为 Infinity(999.0) 或 <1.5mm 时使用保底值
        if vessel_mesh >= 998.0 or vessel_mesh < 1.5:
            vessel_margin = 1.6
        else:
            vessel_margin = vessel_mesh

        if brainstem_mesh >= 998.0 or brainstem_mesh < 1.5:
            brainstem_margin = 1.9
        else:
            brainstem_margin = brainstem_mesh

        electrodes.append({
            'id': e['electrode_idx'] + 1,
            'name': e['electrode_name'],
            'planning_order': e['electrode_idx'] + 1,
            'implant_endpoint': ie,
            'entry_point': ep,
            'direction': e['my_direction'],
            'metrics': {
                # 兼容不同版本字段名：my_coverage / my_coverage_shown / my_coverage_raw
                'coverage': e.get('my_coverage', e.get('my_coverage_shown', e.get('my_coverage_raw', 0.0))),
                'vessel_margin': round(vessel_margin, 2),
                'brainstem_margin': round(brainstem_margin, 2),
                'path_length': round(path_length, 1),
            }
        })

    electrodes.sort(key=lambda x: x['planning_order'])
    return electrodes


def get_scene_cache(patient_id: str) -> Optional[dict]:
    """获取指定病人的缓存场景数据"""
    return _scene_cache.get(patient_id)


def set_scene_cache(patient_id: str, data: dict):
    """缓存指定病人的场景数据"""
    _scene_cache[patient_id] = data


# ============================================================
# [v2 改造] 编辑覆盖文件读写
# 路径：<stl_dir>/edits/plan_{N}.json   （当前生效版本，覆盖式）
#       <stl_dir>/edits/history/plan_{N}_{YYYYMMDD_HHMMSS}.json （永久存档）
# ============================================================
def _edits_dir(patient_id: str) -> Optional[Path]:
    patient = PATIENT_DATA_MAP.get(patient_id)
    if not patient:
        return None
    return Path(patient["stl_dir"]) / "edits"


def load_edit_override(patient_id: str, needle_count: int) -> Optional[List[dict]]:
    """
    若磁盘上存在该病人 + 该针数的编辑覆盖文件，则读出电极数组并返回；否则返回 None。
    """
    edits_dir = _edits_dir(patient_id)
    if edits_dir is None:
        return None
    override_file = edits_dir / f"plan_{needle_count}.json"
    if not override_file.exists():
        return None
    try:
        with open(override_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        electrodes = data.get("electrodes") if isinstance(data, dict) else data
        if isinstance(electrodes, list) and electrodes:
            logger.info(f"加载编辑覆盖: {override_file} ({len(electrodes)} 根)")
            return electrodes
    except Exception as e:
        logger.warning(f"读取编辑覆盖失败 {override_file}: {e}")
    return None


def save_edit_override(patient_id: str, needle_count: int,
                       electrodes: List[dict]) -> Tuple[str, str]:
    """
    将编辑后的电极数组写到磁盘：
    - 覆盖式：<stl_dir>/edits/plan_{N}.json
    - 时间戳存档：<stl_dir>/edits/history/plan_{N}_{YYYYMMDD_HHMMSS}.json
    返回 (saved_path, history_path) 两个绝对路径字符串。
    """
    edits_dir = _edits_dir(patient_id)
    if edits_dir is None:
        raise ValueError(f"未知病人 ID: {patient_id}")
    history_dir = edits_dir / "history"
    edits_dir.mkdir(parents=True, exist_ok=True)
    history_dir.mkdir(parents=True, exist_ok=True)

    payload = {
        "patient_id": patient_id,
        "needle_count": needle_count,
        "saved_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "electrodes": electrodes,
    }

    saved_file = edits_dir / f"plan_{needle_count}.json"
    with open(saved_file, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    history_file = history_dir / f"plan_{needle_count}_{timestamp}.json"
    with open(history_file, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    logger.info(f"保存编辑覆盖: {saved_file}（同时存档 {history_file.name}）")
    return str(saved_file), str(history_file)
