"""Pydantic 数据模型"""
from pydantic import BaseModel
from typing import List, Dict


class ElectrodeMetrics(BaseModel):
    coverage: float           # my_coverage（靶区覆盖率，0~1）
    vessel_margin: float      # my_min_sdf_vessel（血管安全边距 mm，可为负）
    brainstem_margin: float   # my_min_sdf_brainstem（脑干安全边距 mm）
    path_length: float        # 计算值：‖entry_point - implant_endpoint‖


class ElectrodeData(BaseModel):
    id: int                        # electrode_idx + 1（从 1 开始展示）
    name: str                      # electrode_name（如 "TF"）
    planning_order: int            # electrode_idx + 1
    implant_endpoint: List[float]  # my_implant_endpoint [x, y, z]
    entry_point: List[float]       # planned_entry_point [x, y, z]（注意无 my_ 前缀）
    direction: List[float]         # my_direction [dx, dy, dz]
    metrics: ElectrodeMetrics


class SceneData(BaseModel):
    anatomy: Dict[str, str]                # {结构名: base64字符串}
    target_regions: Dict[str, dict]        # {电极名: {"name": "脑区名", "base64": "..."}}
    electrodes: List[ElectrodeData]
