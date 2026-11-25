"""Check the running API and any locally installed case fixtures."""
import argparse
import json
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import ProxyHandler, build_opener

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:8766')
    parser.add_argument('--reference', type=Path, help='Optional original scene directory tree for file comparisons')
    args = parser.parse_args()
    opener = build_opener(ProxyHandler({}))

    def get(path, **params):
        url = args.base_url.rstrip('/') + path
        if params:
            url += '?' + urlencode(params)
        with opener.open(url, timeout=120) as response:
            return json.load(response)

    catalog = get('/api/cases')['cases']
    routes = get('/openapi.json')['paths']
    assert '/api/scene' in routes and '/api/presentation' in routes
    assert all(route not in routes for route in ('/api/analysis', '/api/llm_parse_prompt', '/api/model_status'))
    presentation_file = ROOT / 'data/presentation/cases.json'
    stories = json.loads(presentation_file.read_text(encoding='utf-8')) if presentation_file.is_file() else {}
    assert [case['patient_id'] for case in catalog] == list(stories)

    for index, case in enumerate(catalog):
        patient_id = case['patient_id']
        params = {'patient_id': patient_id}
        relative = Path('data') / f"patient_{int(patient_id.removeprefix('Patient_'))}"
        result = relative / 'evaluation_results.json'
        if args.reference:
            assert (ROOT / result).read_bytes() == (args.reference / result).read_bytes(), result
        base = json.loads((ROOT / result).read_text(encoding='utf-8'))
        assert len(base) == case['base_count']
        for plan in (ROOT / relative / 'edits').glob('plan_*.json'):
            if args.reference:
                assert plan.read_bytes() == (args.reference / plan.relative_to(ROOT)).read_bytes(), plan
            count = int(plan.stem.removeprefix('plan_'))
            saved = json.loads(plan.read_text(encoding='utf-8'))
            electrodes = saved['electrodes'] if isinstance(saved, dict) else saved
            assert get('/api/plan_override', **params, needle_count=count)['electrodes'] == electrodes

        report = get('/api/clinical', **params)
        packaged = json.loads((ROOT / patient_id / 'clinical_report.json').read_text(encoding='utf-8'))
        assert report['subject_id'] == packaged['subject_id']
        assert report['report_text'] == packaged['report_text'] and report['report_text']
        assert report['history'] and report['diagnosis']
        story = get('/api/presentation', **params)
        assert story == stories[patient_id]
        regions = {r['electrodeName'] for r in report['regions']}
        assert {r['electrodeName'] for r in story['regions']} == regions
        assert {key for step in story['steps'] if step['action'] == 'highlight' for key in step['region_keys']} == regions

        if index < 2:
            with opener.open(args.base_url.rstrip('/') + '/api/load?' + urlencode(params), timeout=120) as stream:
                events = [json.loads(line[6:]) for line in stream if line.startswith(b'data: ')]
            assert events[-1]['done'] and 'error' not in events[-1], events[-1]
            scene = get('/api/scene', **params)
            assert len(scene['electrodes']) == len(base)
            assert set(scene['target_regions']) == regions
            assert all(scene['anatomy'].get(name) for name in ('skull', 'vessel', 'brainstem'))
    print(f"PASS: API and {len(catalog)} configured cases")


if __name__ == '__main__':
    main()
