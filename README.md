# SEEG-demo

SEEG-demo 是一个用于讲解立体定向脑电图（SEEG）电极植入方案的 Web 应用。FastAPI 读取病例背景、三维模型和已保存的规划结果，Three.js 展示目标脑区、候选方案和植入动画。用户可在三维视图中调整电极，并保存编辑后的方案。

公开仓库提供应用源码和运行说明。克隆后即可打开首页、查看 API 文档和分析实现。进入病例工作台需要在运行服务的机器上另行配置有权使用的病例资料。

## 快速启动

在克隆后的仓库根目录，使用 Python 3.10 创建环境并启动服务。

```bash
python3.10 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python run.py --port 8766 --no-browser
```

浏览器打开 [应用首页](http://127.0.0.1:8766/)。FastAPI 提供 [交互式 API 文档](http://127.0.0.1:8766/docs)。默认监听本机回环地址，在服务器运行时可通过 SSH 或 VS Code 转发 8766 端口。

在第二个终端运行以下命令，验证 API 和已配置的病例数量。首次克隆时应显示 `PASS: API and 0 configured cases`。

```bash
python3 scripts/smoke_test.py --base-url http://127.0.0.1:8766
```

## 阅读源码

| 入口 | 功能 |
| --- | --- |
| `run.py`、`backend/main.py` | 启动服务，提供病例、方案、场景和编辑接口，通过 SSE 返回三维加载进度 |
| `backend/data_loader.py` | 读取电极与脑区的对应关系、简化 STL 网格、加载方案和保存编辑记录 |
| `backend/clinical_data.py`、`backend/presentation.py` | 读取本地病例报告及预先编写的术前讲解，检查讲解与目标脑区的对应关系 |
| `frontend/index.html` | 创建三维场景，展示候选方案、植入动画并处理电极编辑 |
| `frontend/v3.js`、`frontend/v3.css` | 管理导入流程、临床资料、术前讲解和工作台布局 |
| `scripts/` | 病例资料包构建、API 与浏览器回归检查、截图及场景检查工具 |

## 接入本地病例

已持有授权演示资料时，按原有目录结构放入以下文件，再重启服务。

| 仓库根目录下的位置 | 用途 |
| --- | --- |
| `Patient_NNN/patient_info.json`、`Patient_NNN/clinical_report.json` | 网页从所选文件夹读取病例编号，后台根据编号加载对应的报告 |
| `data/presentation/cases.json` | 按病例编号保存讲解步骤和 `regions`。每个区域的 `electrodeName` 和 `regionName` 用于关联电极及其 STL |
| `data/patient_N/` | 保存解剖结构 STL、`靶点脑区/`、基础方案 `evaluation_results.json` 和可选的 `edits/`。目录中的 N 为去除前导零的病例序号 |
| `exports/SEEG-v3-病例数据包.zip` | 可选。供 `/api/case-packages` 下载的本地导入包 |

前端接受 `Patient_001` 至 `Patient_008` 格式的演示入口。在首页导入已配置的病例文件夹后，可阅读临床摘要、查看术前探测目标、选择方案并编辑电极。选择文件夹这一步用于识别病例，网格和报告由后端从本地磁盘读取。

如需从原始表格重建报告，可运行 `python scripts/build_clinical_cases.py --help`。该工具需要在本机提供数据集、临床补充记录、病例对应表、`data/clinical/legacy_case_report_notes.json` 及现有的病例入口文件。运行服务本身使用已整理好的资料。

## 许可

项目原创代码采用 [MIT 许可证](LICENSE)。Three.js r128 及其控制器采用 [上游 MIT 许可证](frontend/vendor/LICENSE-three.txt)。界面所用校徽和校名标识归深圳理工大学所有。[标识来源](frontend/assets/suat-official-horizontal.source.json)
