"""FastAPI 应用主文件"""
import json
import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse, JSONResponse, FileResponse

from .clinical_data import get_case_catalog, get_clinical_case
from .presentation import get_presentation

from .data_loader import (
    PATIENT_DATA_MAP,
    STL_NAME_PATTERNS,
    load_anatomy_with_progress,
    load_target_regions_with_progress,
    parse_evaluation_results,
    get_scene_cache,
    set_scene_cache,
    load_edit_override,
    save_edit_override,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="SEEG Demo v3")


@app.get("/api/case-packages")
def download_case_packages():
    archive = Path(__file__).resolve().parents[1] / "exports/SEEG-v3-病例数据包.zip"
    if not archive.is_file():
        raise HTTPException(status_code=404, detail="本机尚未配置病例资料包")
    return FileResponse(archive, media_type="application/zip", filename="SEEG-v3-病例数据包.zip")


def clinical_case(patient_id):
    if patient_id not in PATIENT_DATA_MAP:
        raise HTTPException(status_code=404, detail=f"未知病例 ID: {patient_id}")
    return get_clinical_case(patient_id)


@app.get("/api/cases")
def get_cases():
    return {"cases": get_case_catalog()}


@app.get("/api/clinical")
def get_clinical(patient_id: str = Query(...)):
    return clinical_case(patient_id)


@app.get("/api/presentation")
def get_planning_presentation(patient_id: str = Query(...)):
    if patient_id not in PATIENT_DATA_MAP:
        raise HTTPException(status_code=404, detail="未找到此病例")
    return get_presentation(patient_id)


def sse_event(progress: int, message: str, done: bool = False, error: str = None,
              kind: str = "progress") -> str:
    """
    构造 SSE 事件字符串。
    kind: "progress" = 病例资料和场景加载进度。
    """
    payload = {"progress": progress, "message": message, "done": done, "kind": kind}
    if error:
        payload["error"] = error
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def generate_progress(patient_id: str):
    """
    加载病例场景并返回各阶段的进度。
    """
    import time
    patient = PATIENT_DATA_MAP.get(patient_id)
    if not patient:
        yield sse_event(0, "", error=f"未知病人 ID: {patient_id}")
        return

    stl_dir = patient["stl_dir"]
    result_file = patient["result_file"]
    target_map = patient.get("target_map", {})
    total_structures = len(STL_NAME_PATTERNS)
    total_targets = len(target_map)
    anatomy = {}
    target_regions = {}

    # ─── 阶段 1：识别病人元数据 ───────────────────────
    yield sse_event(2, f"接收病人上传：{patient_id}")
    time.sleep(0.5)
    yield sse_event(5, "元数据解析完成")
    time.sleep(0.35)

    # ─── 阶段 2：识别靶点脑区清单 ─────────────────────
    yield sse_event(8, "解析靶点脑区探测表")
    time.sleep(0.5)
    yield sse_event(12, f"病例探测脑区：{total_targets} 个")
    time.sleep(0.35)
    yield sse_event(15, "执行 靶区名 ↔ STL 文件 语义映射")
    time.sleep(0.45)
    yield sse_event(18, f"映射成功：{total_targets} 个靶区")
    time.sleep(0.3)

    # ─── 阶段 3：加载解剖结构 STL ─────────────────────
    yield sse_event(20, "加载解剖背景：颅骨 / 大脑 / 血管 / 脑干")

    for name, b64, seq in load_anatomy_with_progress(stl_dir):
        if b64:
            anatomy[name] = b64
        pct = int(20 + (seq / total_structures) * 25)
        yield sse_event(pct, f"加载解剖结构 {seq}/{total_structures} ...", kind="progress")

    yield sse_event(46, "解剖结构加载完毕")
    time.sleep(0.35)

    # ─── 阶段 4：解析多电极协同规划结果 ───────────────
    yield sse_event(48, "读取该病例已保存的候选方案")
    time.sleep(0.45)
    electrodes = parse_evaluation_results(result_file)
    # [v2 改造] 加载阶段命中编辑覆盖文件则替换 base 电极
    override = load_edit_override(patient_id, len(electrodes))
    if override is not None:
        electrodes = override
        yield sse_event(54, f"命中人工微调版本（{len(electrodes)} 根），优先采用")
        time.sleep(0.3)
    yield sse_event(55, f"解析完成：{len(electrodes)} 根电极几何参数")
    time.sleep(0.35)

    # ─── 阶段 5：加载靶点脑区 STL ─────────────────────
    yield sse_event(60, "加载靶点脑区三维网格")

    for elec_name, region_name, b64, seq in load_target_regions_with_progress(stl_dir, electrodes, target_map):
        if b64:
            target_regions[elec_name] = {"name": region_name, "base64": b64}
        pct = int(60 + (seq / total_targets) * 28)
        msg = f"加载靶点脑区 {region_name or elec_name} ({seq}/{total_targets}) ..."
        yield sse_event(pct, msg, kind="progress")

    yield sse_event(89, f"靶点脑区加载完毕：{total_targets} 个")
    time.sleep(0.3)

    # ─── 阶段 6：构建场景 ──────────────────────────
    scene_data = {
        "anatomy": anatomy,
        "target_regions": target_regions,
        "electrodes": electrodes,
    }
    set_scene_cache(patient_id, scene_data)

    yield sse_event(94, "组装 3D 可视化场景")
    time.sleep(0.45)
    yield sse_event(98, "关联临床资料与探测脑区")
    time.sleep(0.35)
    yield sse_event(100, "资料已就绪，进入植入规划工作台", done=True)


@app.get("/api/load")
def load_data(patient_id: str = Query(...)):
    """SSE 端点：加载病人数据并推送进度"""
    return StreamingResponse(
        generate_progress(patient_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        }
    )


@app.get("/api/scene")
def get_scene(patient_id: str = Query(...)):
    """返回缓存的场景数据（anatomy + target_regions + electrodes）"""
    cache = get_scene_cache(patient_id)
    if cache is None:
        return JSONResponse(
            status_code=400,
            content={"error": f"病人 {patient_id} 的场景数据尚未加载，请先调用 /api/load"}
        )
    return JSONResponse(content=cache)


# ============================================================
# [v2 改造] 编辑模式相关端点：保存 + 读取覆盖
# ============================================================
@app.get("/api/plan_override")
def get_plan_override(patient_id: str = Query(...), needle_count: int = Query(...)):
    """
    返回该病人 + 该针数的编辑覆盖电极数组；命中返回 {electrodes:[...]}, 未命中 {electrodes:null}。
    前端 buildPlanVariants 在生成 9/11 根方案前调用，命中则替换扩展逻辑结果。
    """
    override = load_edit_override(patient_id, needle_count)
    return JSONResponse(content={"electrodes": override})


@app.post("/api/save_electrode_edit")
async def save_electrode_edit(request: Request):
    """
    保存编辑后的电极数组：
    入参: {patient_id, plan_id, needle_count, electrodes:[...]}
    行为:
      1. 写覆盖文件 + history 时间戳存档
      2. 同步更新 _scene_cache（仅当当前缓存的电极数等于 needle_count 时）
    """
    body = await request.json()
    patient_id = body.get("patient_id")
    needle_count = body.get("needle_count")
    electrodes = body.get("electrodes")
    plan_id = body.get("plan_id")

    if not patient_id or needle_count is None or not isinstance(electrodes, list):
        return JSONResponse(
            status_code=400,
            content={"ok": False, "error": "缺少必要字段 patient_id / needle_count / electrodes"}
        )

    try:
        saved_path, history_path = save_edit_override(patient_id, int(needle_count), electrodes)
    except Exception as e:
        logger.exception("保存编辑覆盖失败")
        return JSONResponse(status_code=500, content={"ok": False, "error": str(e)})

    # 当前内存缓存命中同针数则同步更新（让本进程后续请求也立即生效）
    cache = get_scene_cache(patient_id)
    if cache is not None and len(cache.get("electrodes", [])) == int(needle_count):
        cache["electrodes"] = electrodes
        set_scene_cache(patient_id, cache)

    return JSONResponse(content={
        "ok": True,
        "plan_id": plan_id,
        "needle_count": int(needle_count),
        "saved_to": saved_path,
        "history_file": history_path,
    })


# 静态文件服务（必须在 API 路由之后注册，否则会拦截 /api/* 请求）
frontend_dir = Path(__file__).parent.parent / "frontend"
app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")
