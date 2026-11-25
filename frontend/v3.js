/* Prepared planning narrative and clinical context around the existing Three.js workspace. */
let v3Generation = 0;
let v3Controller = null;
let v3LoadSource = null;
let v3Clinical = null;
const v3ClinicalCache = {};
const v3StoryCache = {};
const v3Pulses = new Map();
const v3Pending = new Set();
let v3Review = null;
let v3WorkflowStep = 0;
let v3LoadingScrollFrame = null;
let v3AnalysisScrollFrame = null;
const v3WorkflowLabels = ['读取病例资料', '整理探测需求', '构建三维解剖', '定位探测目标', '准备植入方案'];
const v3PlaybackCharsPerSecond = 40;
const v3ReviewDuration = 20000;

function v3Wait(milliseconds, generation) {
    return new Promise((resolve, reject) => {
        if (generation !== v3Generation) { reject(new DOMException('已取消', 'AbortError')); return; }
        const cancel = () => { clearTimeout(timer); v3Pending.delete(cancel); reject(new DOMException('已取消', 'AbortError')); };
        const timer = setTimeout(() => { v3Pending.delete(cancel); resolve(); }, milliseconds);
        v3Pending.add(cancel);
    });
}
function v3SetAnalysisStatus(message) {
    $v3('analysis-status').textContent = message;
    $v3('analysis-review-status').textContent = message;
    v3FollowAnalysis();
}
function v3FollowLoading() {
    if (v3LoadingScrollFrame !== null) return;
    const generation = v3Generation;
    v3LoadingScrollFrame = requestAnimationFrame(() => {
        v3LoadingScrollFrame = null;
        if (generation !== v3Generation || currentState !== APP_STATE.CONFIRM) return;
        const list = $v3('loading-thoughts-list');
        list.scrollTop = list.scrollHeight;
        const panel = $v3('confirm-panel');
        panel.scrollTop = panel.scrollHeight;
    });
}
function v3FollowAnalysis() {
    if (v3AnalysisScrollFrame !== null) return;
    const generation = v3Generation;
    v3AnalysisScrollFrame = requestAnimationFrame(() => {
        v3AnalysisScrollFrame = null;
        if (generation !== v3Generation || currentState !== APP_STATE.PARSING) return;
        const output = $v3('analysis-output');
        output.scrollTop = output.scrollHeight;
        const panel = $v3('clinical-panel');
        panel.scrollTop = panel.scrollHeight;
        const review = $v3('analysis-review-text');
        review.scrollTop = review.scrollHeight;
    });
}
function v3SetStoryText(current, transcript = current) {
    if ($v3('analysis-review-text').textContent === current && $v3('analysis-output').textContent === transcript) return;
    $v3('analysis-review-text').textContent = current;
    $v3('analysis-output').textContent = transcript;
    v3FollowAnalysis();
}
function v3ResetReview() {
    if (v3Review) v3Review.cancel();
    v3Review = null;
    $v3('analysis-review-actions').classList.add('hidden');
    $v3('analysis-read-countdown').textContent = '';
    $v3('analysis-keep-reading').disabled = false;
    $v3('analysis-view-plans').disabled = false;
    $v3('analysis-view-plans').textContent = '查看植入方案';
}
function v3WorkflowStage(stage, active = true) {
    $v3('case-workflow-status').textContent = stage >= 5 ? '全部准备完成' : active ? v3WorkflowLabels[stage] : '病例报告已整理';
    while (v3WorkflowStep < stage) {
        const item = document.createElement('div');
        item.className = 'loading-thought stream-bubble';
        item.textContent = `${v3WorkflowLabels[v3WorkflowStep]} · 已完成`;
        $v3('loading-thoughts-list').appendChild(item);
        v3WorkflowStep++;
    }
    document.querySelectorAll('#case-workflow-steps [data-workflow-step]').forEach(element => {
        const index = Number(element.dataset.workflowStep);
        element.classList.toggle('complete', index < stage);
        element.classList.toggle('active', active && index === stage);
        element.classList.toggle('pending', index > stage || (!active && index === stage));
    });
    v3FollowLoading();
}

const $v3 = id => document.getElementById(id);
const v3Text = value => typeof value === 'string' ? value : value == null ? '' : Array.isArray(value) ? value.map(v3Text).join('\n') : Object.entries(value).map(([k, v]) => `${k}：${v3Text(v)}`).join('\n');
const v3Escape = value => v3Text(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function v3CancelWork() {
    v3Generation++;
    cancelAnimationFrame(v3LoadingScrollFrame);
    cancelAnimationFrame(v3AnalysisScrollFrame);
    v3LoadingScrollFrame = null;
    v3AnalysisScrollFrame = null;
    for (const cancel of [...v3Pending]) cancel();
    v3ResetReview();
    if (v3Controller) v3Controller.abort();
    v3Controller = null;
    if (v3LoadSource) v3LoadSource.close();
    v3LoadSource = null;
    for (const cancel of v3Pulses.values()) cancel();
    v3Pulses.clear();
}
function v3RememberPlans() {
    if (currentPatientId && patientCache[currentPatientId]) {
        const cache = patientCache[currentPatientId];
        cache.plans = cachedPlans;
        cache.planId = currentPlanId;
        cache.ready = [APP_STATE.INTERACT, APP_STATE.ANIM].includes(currentState);
        cache.recognized = recognizedRegions;
    }
}
window.v3OnState = state => {
    document.body.dataset.state = state;
    if (state !== APP_STATE.PARSING) v3ResetReview();
    const step = ['import', 'confirm'].includes(state) ? 0 : ['prompt','parsing'].includes(state) ? 1 : state === 'plan_select' ? 2 : 3;
    document.querySelectorAll('#workflow-steps [data-step]').forEach(el => {
        el.classList.toggle('active', Number(el.dataset.step) === step);
        el.classList.toggle('complete', Number(el.dataset.step) < step);
    });
    $v3('workspace-context').textContent = state === 'import' ? '临床科研工作台' : patientId || '临床科研工作台';
    $v3('edit-plan-btn').classList.toggle('hidden', state !== APP_STATE.INTERACT);
    if (renderer) requestAnimationFrame(triggerResize);
};

async function v3ConfirmPatient(pid) {
    if (!/^Patient_00[1-8]$/.test(pid || '')) throw new Error('无法读取此病例数据包，请重新选择');
    v3CancelWork();
    v3RememberPlans();
    if (editing) exitEditMode();
    if (renderer) disposeRenderer();
    patientId = pid;
    currentPatientId = null;
    sceneData = null;
    const generation = v3Generation;
    v3Controller = new AbortController();
    $v3('patient-card').innerHTML = `<div class="eyebrow">CASE CONFIRMATION</div><div class="pid">${pid}</div><div class="meta">正在载入病例报告…</div>`;
    $v3('start-btn').disabled = true;
    $v3('start-btn').textContent = '进入规划工作台 →';
    $v3('start-btn').classList.add('hidden');
    $v3('confirm-card').classList.add('is-loading');
    $v3('loading-thoughts-area').classList.remove('hidden');
    $v3('loading-thoughts-list').innerHTML = '';
    v3WorkflowStep = 0;
    v3WorkflowStage(0);
    $v3('loading-progress-fill').style.width = '4%';
    $v3('loading-progress-hint').textContent = '正在读取病例资料…';
    setState(APP_STATE.CONFIRM);
    try {
        const clinicalRequest = fetch(`/api/clinical?patient_id=${encodeURIComponent(pid)}`, {signal: v3Controller.signal})
            .then(async response => {
                if (!response.ok) throw new Error('病例资料读取失败');
                return response.json();
            }).then(clinical => ({clinical}), error => ({error}));
        const [result] = await Promise.all([clinicalRequest, v3Wait(1300, generation)]);
        if (result.error) throw result.error;
        v3WorkflowStage(1);
        $v3('loading-progress-fill').style.width = '16%';
        $v3('loading-progress-hint').textContent = '正在整理探测需求…';
        await v3Wait(1400, generation);
        const clinical = result.clinical;
        if (generation !== v3Generation) return;
        v3ClinicalCache[pid] = clinical;
        v3Clinical = clinical;
        $v3('patient-card').innerHTML = `<div class="eyebrow">CASE REVIEW</div><div class="patient-card-heading"><div class="pid">${v3Escape(pid)}</div><span class="case-status">病例资料已载入</span></div><div class="meta">${v3Escape([clinical.sex, clinical.age ? `${clinical.age} 岁` : ''].filter(Boolean).join(' · '))}</div><div class="confirm-clinical"><h3>临床诊断</h3><p>${v3Escape(clinical.diagnosis)}</p><h3>病史背景</h3><p>${v3Escape(v3BriefHistory(clinical.history))}</p></div><div class="confirm-evidence">${clinical.regions?.length || 0} 个目标脑区 · 影像资料与候选植入方案</div>`;
        v3WorkflowStage(2, false);
        $v3('loading-progress-fill').style.width = '30%';
        $v3('loading-progress-hint').textContent = '病例报告已整理，进入工作台后继续准备三维视图。';
        $v3('confirm-card').classList.remove('is-loading');
        $v3('start-btn').disabled = false;
        $v3('start-btn').classList.remove('hidden');
        v3RenderClinical(clinical);
    } catch (err) {
        if (generation !== v3Generation || err.name === 'AbortError') return;
        $v3('confirm-card').classList.remove('is-loading');
        $v3('loading-progress-hint').textContent = '病例资料读取失败，可重新载入。';
        $v3('case-workflow-status').textContent = '请重新载入病例资料';
        $v3('patient-card').querySelector('.meta').textContent = '无法读取此病例数据包，请重新选择';
        $v3('patient-card').insertAdjacentHTML('beforeend', '<button class="text-button" onclick="v3ConfirmPatient(patientId)">重新载入资料 →</button>');
        v3FollowLoading();
    }
}
async function v3ImportFile(file) {
    $v3('import-error').classList.add('hidden');
    try {
        if (!file) throw new Error('无法读取此病例数据包，请重新选择');
        const info = JSON.parse(await file.text());
        await v3ConfirmPatient(info.patient_id);
    } catch (err) {
        $v3('import-error').textContent = '无法读取此病例数据包，请重新选择';
        $v3('import-error').classList.remove('hidden');
    }
}
function v3RenderClinical(clinical) {
    $v3('clinical-patient-id').textContent = clinical.patient_id;
    $v3('clinical-meta').textContent = [clinical.sex, clinical.age ? `${clinical.age} 岁` : ''].filter(Boolean).join(' · ');
    $v3('clinical-diagnosis').textContent = v3Text(clinical.diagnosis);
    $v3('clinical-history').textContent = v3Text(clinical.history);
    $v3('clinical-report-title').textContent = clinical.report_title;
    $v3('clinical-report').textContent = clinical.report_text;
    $v3('clinical-imaging').textContent = v3Text(clinical.imaging_summary);
    $v3('clinical-record-count').textContent = `${(clinical.sources || []).length} 项`;
    $v3('clinical-sources').innerHTML = '';
    for (const source of clinical.sources || []) {
        const detail = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = source.title;
        const text = document.createElement('div');
        text.className = 'source-text'; text.textContent = source.text;
        detail.append(summary, text); $v3('clinical-sources').appendChild(detail);
    }
    v3RenderRegions(clinical.regions || []);
    const story = v3StoryCache[clinical.patient_id];
    v3SetStoryText(story?.steps.at(-1)?.text || '', story ? v3StoryTranscript(story) : '开始术前分析，查看探测目标与脑区位置。');
    v3SetAnalysisStatus(story ? '术前分析已载入' : '等待开始术前分析');
    $v3('analysis-errors').classList.add('hidden');
}
async function v3RestoreClinical(pid) {
    v3Clinical = v3ClinicalCache[pid] || null;
    recognizedRegions = patientCache[pid]?.recognized || [];
    if (v3Clinical) v3RenderClinical(v3Clinical);
    else {
        const generation = v3Generation;
        try {
            const response = await fetch(`/api/clinical?patient_id=${encodeURIComponent(pid)}`);
            if (!response.ok) return;
            const data = await response.json();
            if (generation !== v3Generation || patientId !== pid) return;
            v3Clinical = data; v3ClinicalCache[pid] = data; v3RenderClinical(data);
        } catch (err) { console.warn('临床资料读取失败', err); }
    }
}
function v3RenderRegions(regions) {
    $v3('region-count').textContent = `${regions.length} 个`;
    for (const id of ['clinical-regions', 'analysis-review-regions']) {
        const container = $v3(id);
        container.innerHTML = '';
        for (const region of regions) {
            const chip = document.createElement('button');
            chip.className = 'region-chip';
            chip.dataset.electrode = region.electrodeName;
            chip.textContent = region.regionName || region.electrodeName;
            chip.title = [region.reason, region.source_quote].filter(Boolean).join('\n') || '在三维视图中高亮';
            chip.onclick = () => v3FocusRegion(region.electrodeName);
            container.appendChild(chip);
        }
    }
}
function v3FocusRegion(key) {
    const mesh = targetRegionMeshes[key];
    if (!mesh) return;
    v3Pulses.get(key)?.();
    document.querySelectorAll('.region-chip').forEach(chip => chip.classList.toggle('selected', chip.dataset.electrode === key));
    mesh.visible = true;
    const material = mesh.material;
    const emissive = material.emissive.clone(), intensity = material.emissiveIntensity, opacity = material.opacity;
    const start = performance.now();
    let frame;
    const stop = () => { cancelAnimationFrame(frame); material.emissive.copy(emissive); material.emissiveIntensity = intensity; material.opacity = opacity; v3Pulses.delete(key); };
    v3Pulses.set(key, stop);
    const tick = now => {
        if (now - start > 1300) { stop(); return; }
        material.emissive.setHex(0x40dfcc);
        material.emissiveIntensity = 0.45 + 0.3 * Math.sin((now - start) / 100);
        material.opacity = 0.85;
        frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
}
function startLoading() {
    v3CancelWork();
    const generation = v3Generation;
    const pid = patientId;
    $v3('start-btn').classList.add('hidden');
    $v3('loading-thoughts-area').classList.remove('hidden');
    $v3('confirm-card').classList.add('is-loading');
    v3WorkflowStage(2);
    $v3('loading-progress-fill').style.width = '30%';
    $v3('loading-progress-hint').textContent = '正在构建三维解剖…';
    v3LoadSource = new EventSource(`/api/load?patient_id=${encodeURIComponent(pid)}`);
    const failure = message => {
        v3LoadSource?.close(); v3LoadSource = null;
        $v3('confirm-card').classList.remove('is-loading');
        $v3('loading-progress-hint').textContent = message;
        $v3('case-workflow-status').textContent = '请重新加载工作台';
        $v3('start-btn').textContent = '重新加载工作台'; $v3('start-btn').classList.remove('hidden');
        v3FollowLoading();
    };
    v3LoadSource.onmessage = async event => {
        if (generation !== v3Generation) return;
        try {
            const data = JSON.parse(event.data);
            if (data.error) { failure('病例资料载入失败，请重新载入。'); return; }
            const progress = Number(data.progress) || 0;
            const stage = progress >= 89 ? 4 : progress >= 46 ? 3 : 2;
            v3WorkflowStage(stage);
            $v3('loading-progress-fill').style.width = `${30 + progress * 0.7}%`;
            $v3('loading-progress-hint').textContent = `${v3WorkflowLabels[stage]}…`;
            if (data.done) {
                v3LoadSource.close(); v3LoadSource = null;
                await fetchSceneData(generation, pid);
            }
        } catch (err) { if (generation === v3Generation) failure('病例资料载入失败，请重新载入。'); }
    };
    v3LoadSource.onerror = () => { if (generation === v3Generation) failure('加载连接中断，请重新加载工作台。'); };
}
async function fetchSceneData(generation = v3Generation, pid = patientId) {
    v3Controller = new AbortController();
    const response = await fetch(`/api/scene?patient_id=${encodeURIComponent(pid)}`, {signal: v3Controller.signal});
    if (!response.ok) throw new Error('三维场景读取失败，请重新加载。');
    const data = await response.json();
    if (generation !== v3Generation) return;
    sceneData = data; currentPatientId = pid;
    cachedPlans = { A:null, B:null, C:null }; currentPlanId = 'A'; activeElectrodes = null; recognizedRegions = [];
    const now = new Date();
    patientCache[pid] = {sceneData, timestamp: now, electrodeCount: sceneData.electrodes.length, baseElectrodes: sceneData.electrodes.map(e => ({...e}))};
    if (!processedPatients.find(p => p.id === pid)) processedPatients.push({id: pid, timestamp: now});
    v3WorkflowStage(5);
    $v3('loading-progress-fill').style.width = '100%';
    $v3('loading-progress-hint').textContent = '病例资料已就绪，正在进入工作台…';
    await v3Wait(1500, generation);
    if (generation !== v3Generation) return;
    setState(APP_STATE.PROMPT);
    initThreeScene(); loadAnatomyModels(); loadTargetRegions({initiallyVisible:false});
    clearElectrodeList(); updatePatientHistory();
    prepareDoctorPrompt();
    $v3('loading-thoughts-area').classList.add('hidden');
    $v3('confirm-card').classList.remove('is-loading');
    requestAnimationFrame(triggerResize);
}
function v3BriefHistory(history) {
    const text = v3Text(history).trim();
    return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}
function v3StoryTranscript(story) {
    return story.steps.map(step => `${step.title}\n${step.text}`).join('\n\n');
}
function prepareDoctorPrompt() {
    $v3('prompt-diagnosis').textContent = v3Text(v3Clinical?.diagnosis);
    $v3('prompt-history').textContent = v3BriefHistory(v3Clinical?.history);
    $v3('prompt-regions').innerHTML = (v3Clinical?.regions || []).map(region => `<span class="region-chip">${v3Escape(region.regionName || region.electrodeName)}</span>`).join('');
    $v3('start-ai-btn').onclick = startPlanningStory;
}
function v3StoryTargets(keys) {
    for (const cancel of [...v3Pulses.values()]) cancel();
    Object.entries(targetRegionMeshes).forEach(([key, mesh]) => { mesh.visible = keys.includes(key); });
    document.querySelectorAll('.region-chip').forEach(chip => chip.classList.toggle('selected', keys.includes(chip.dataset.electrode)));
}
async function v3HighlightGroup(keys, generation) {
    v3StoryTargets([]);
    for (const key of keys) {
        v3FocusRegion(key);
        await v3Wait(650, generation);
    }
    v3StoryTargets(keys);
}
async function v3PlayStoryText(step, previous, generation) {
    const text = step.text;
    const started = performance.now();
    let visible = 0;
    while (visible < text.length) {
        if (generation !== v3Generation) throw new DOMException('已取消', 'AbortError');
        visible = Math.min(text.length, Math.floor((performance.now() - started) * v3PlaybackCharsPerSecond / 1000));
        const current = text.slice(0, visible);
        v3SetStoryText(current, [...previous, `${step.title}\n${current}`].join('\n\n'));
        if (visible < text.length) await v3Wait(50, generation);
    }
}
function v3ReadReview(generation) {
    return new Promise((resolve, reject) => {
        const deadline = performance.now() + v3ReviewDuration;
        let settled = false;
        const finish = () => {
            if (settled || generation !== v3Generation) return;
            settled = true;
            clearInterval(timer);
            v3Pending.delete(cancel);
            v3Review.phase = 'opening';
            $v3('analysis-read-countdown').textContent = '正在准备植入方案…';
            $v3('analysis-view-plans').disabled = true;
            $v3('analysis-keep-reading').disabled = true;
            resolve();
        };
        const cancel = () => {
            clearInterval(timer);
            v3Pending.delete(cancel);
            if (settled) return;
            settled = true;
            reject(new DOMException('已取消', 'AbortError'));
        };
        const updateCountdown = () => {
            if (generation !== v3Generation) { cancel(); return; }
            const remaining = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
            v3Review.remaining = remaining;
            $v3('analysis-read-countdown').textContent = `${remaining} 秒后展示植入方案`;
            if (!remaining) finish();
        };
        const timer = setInterval(updateCountdown, 250);
        v3Review = {generation, phase: 'reading', paused: false, remaining: v3ReviewDuration / 1000, cancel};
        v3Pending.add(cancel);
        $v3('analysis-review-actions').classList.remove('hidden');
        $v3('analysis-view-plans').onclick = finish;
        $v3('analysis-keep-reading').onclick = () => {
            if (settled || generation !== v3Generation) return;
            clearInterval(timer);
            v3Review.phase = 'paused';
            v3Review.paused = true;
            $v3('analysis-read-countdown').textContent = '已暂停自动展示，可继续阅读';
            $v3('analysis-keep-reading').disabled = true;
        };
        updateCountdown();
        // The reading controls reduce the text viewport once; the countdown leaves scrolling alone.
        v3FollowAnalysis();
    });
}
async function startPlanningStory() {
    v3CancelWork();
    const generation = v3Generation, pid = patientId;
    v3Controller = new AbortController();
    recognizedRegions = [];
    clearElectrodesFromScene();
    v3StoryTargets([]);
    v3SetStoryText('');
    $v3('analysis-review-regions').innerHTML = '';
    $v3('story-stages').innerHTML = '';
    $v3('analysis-errors').classList.add('hidden');
    v3SetAnalysisStatus('正在准备术前分析…');
    setState(APP_STATE.PARSING);
    try {
        let story = v3StoryCache[pid];
        if (!story) {
            const response = await fetch(`/api/presentation?patient_id=${encodeURIComponent(pid)}`, {signal: v3Controller.signal});
            if (!response.ok) throw new Error('术前分析读取失败');
            story = await response.json();
            if (generation !== v3Generation) return;
            v3StoryCache[pid] = story;
        }
        recognizedRegions = story.regions;
        v3RenderRegions(recognizedRegions);
        patientCache[pid].recognized = recognizedRegions;
        patientCache[pid].story = story;
        const preparingPlans = buildPlanVariants(patientCache[pid].baseElectrodes)
            .then(plans => ({plans}), error => ({error}));
        $v3('story-stages').innerHTML = story.steps.map((step, index) => `<span class="story-stage" data-story-step="${index}">${v3Escape(step.title)}</span>`).join('');
        const transcript = [];
        for (let index = 0; index < story.steps.length; index++) {
            const step = story.steps[index];
            if (generation !== v3Generation) return;
            $v3('story-step-title').textContent = step.title;
            document.querySelectorAll('.story-stage').forEach((element, i) => {
                element.classList.toggle('active', i === index);
                element.classList.toggle('complete', i < index);
            });
            v3SetAnalysisStatus(step.title);
            if (step.action === 'highlight') {
                await Promise.all([v3PlayStoryText(step, transcript, generation), v3HighlightGroup(step.region_keys, generation)]);
            } else {
                if (step.action === 'compare') v3StoryTargets(recognizedRegions.map(region => region.electrodeName));
                await v3PlayStoryText(step, transcript, generation);
            }
            transcript.push(`${step.title}\n${step.text}`);
            if (index < story.steps.length - 1) await v3Wait(900, generation);
        }
        v3SetAnalysisStatus('术前分析完成 · 阅读后选择植入方案');
        // Keep the completed preoperative analysis readable before plan selection.
        await v3ReadReview(generation);
        if (generation !== v3Generation) return;
        const result = await preparingPlans;
        if (generation !== v3Generation) return;
        if (result.error) throw result.error;
        cachedPlans = Object.fromEntries(result.plans.map(plan => [plan.id, plan]));
        renderPlanSelector(result.plans);
        setState(APP_STATE.PLAN_SELECT);
    } catch (err) {
        if (err.name === 'AbortError' || generation !== v3Generation) return;
        console.error('术前分析至方案选择的页面跳转失败', err);
        v3ResetReview();
        v3SetAnalysisStatus('术前分析暂未完成');
        $v3('analysis-error-message').textContent = '术前分析暂未完成，请重新开始。';
        $v3('analysis-errors').classList.remove('hidden');
    }
}

$v3('import-btn').onclick = () => $v3('folder-input').click();
$v3('folder-input').onchange = event => { const file = Array.from(event.target.files).find(f => f.name === 'patient_info.json'); event.target.value = ''; v3ImportFile(file); };
$v3('patient-json-input').onchange = event => { const file = event.target.files[0]; event.target.value = ''; if (file) v3ImportFile(file); };
$v3('confirm-back-btn').onclick = () => { v3CancelWork(); backToImport(); };
$v3('start-btn').onclick = startLoading;
$v3('analysis-retry-btn').onclick = startPlanningStory;
window.addEventListener('beforeunload', v3CancelWork);
window.v3OnState(APP_STATE.IMPORT);
