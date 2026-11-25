// Browser UI regression using live local API responses relayed through CDP.
// The relay buffers scene-loading events before passing them to the page.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] || 'http://127.0.0.1:8766';
const screenshots = resolve(root, 'docs/screenshots');
await mkdir(screenshots, {recursive:true});
await mkdir(resolve(root,'.tmp'), {recursive:true});
await mkdir(resolve(root,'.runtime'), {recursive:true});
async function readFixture(id) {
  return JSON.parse(await readFile(resolve(root, id, 'clinical_report.json'), 'utf8'));
}
const firstReport = await readFixture('Patient_001');
const secondReport = await readFixture('Patient_002');
const profile = await mkdtemp(resolve(root,'.tmp/browser-ui-'));
const browser = spawn('/usr/bin/google-chrome', ['--headless=new','--no-first-run',
  '--no-default-browser-check','--disable-background-networking','--disable-component-update',
  '--no-proxy-server','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',
  `--user-data-dir=${profile}`,'--remote-debugging-port=0','about:blank'], {stdio:['ignore','ignore','pipe']});
let socket, browserLog = '';
const results = [], errors = [], requests = [];
try {
  const endpoint = await new Promise((done, fail) => {
    const timer = setTimeout(()=>fail(new Error('Chrome startup timed out')),15000);
    browser.stderr.on('data', bytes => {
      browserLog += bytes.toString();
      const match = browserLog.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {clearTimeout(timer);done(match[1]);}
    });
    browser.once('error',fail);
  });
  const pages = await fetch(`http://${new URL(endpoint).host}/json/list`).then(r=>r.json());
  socket = new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
  await new Promise((done,fail)=>{socket.addEventListener('open',done,{once:true});socket.addEventListener('error',fail,{once:true});});
  let nextId = 0;
  const pending = new Map();
  const call = (method,params={}) => new Promise((done,fail)=>{
    const id = ++nextId;
    const timer=setTimeout(()=>{pending.delete(id);fail(new Error(`CDP timeout ${method}`));},120000);
    pending.set(id,{done,fail,timer});socket.send(JSON.stringify({id,method,params}));
  });
  socket.addEventListener('message',event=>{
    const payload=JSON.parse(event.data);
    if(payload.method==='Runtime.exceptionThrown') errors.push(payload.params.exceptionDetails);
    if(payload.method==='Runtime.bindingCalled' && payload.params.name==='seegTestRequest') {
      const request=JSON.parse(payload.params.payload); requests.push(request.url);
      (async()=>{
        try {
          const response=await fetch(new URL(request.url,base),{method:request.method,
            headers:{Connection:'close',...(request.body?{'Content-Type':'application/json'}:{})},body:request.body||undefined});
          const text=await response.text();
          await call('Runtime.evaluate',{expression:`window.seegTestResolve(${request.id},${JSON.stringify(text)},${response.status},${JSON.stringify(response.headers.get('content-type')||'text/plain')})`});
        } catch(error) {
          errors.push({request:request.url,error:error.message,cause:String(error.cause || '')});
          await call('Runtime.evaluate',{expression:`window.seegTestReject(${request.id},${JSON.stringify(error.message)})`});
        }
      })();
    }
    if(!pending.has(payload.id))return;
    const {done,fail,timer}=pending.get(payload.id);pending.delete(payload.id);clearTimeout(timer);
    payload.error?fail(new Error(JSON.stringify(payload.error))):done(payload.result);
  });
  const evaluate=async expression=>{
    const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const wait=async(expression,timeout=90000)=>{
    const deadline=Date.now()+timeout;
    while(!await evaluate(`Boolean(${expression})`)){
      if(Date.now()>deadline)throw new Error(`Timed out: ${expression}`);
      await new Promise(done=>setTimeout(done,200));
    }
  };
  const capture=async name=>{
    await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const image=await call('Page.captureScreenshot',{format:'png'});
    await writeFile(resolve(screenshots,name),Buffer.from(image.data,'base64'));
  };
  const check=async(name,expression)=>{
    const ok=await evaluate(expression);if(!ok)throw new Error(`Failed ${name}`);
    results.push(name);console.log('PASS',name);
  };
  await call('Runtime.enable');await call('Page.enable');await call('DOM.enable');
  await call('Runtime.addBinding',{name:'seegTestRequest'});
  await call('Page.addScriptToEvaluateOnNewDocument',{source:`
    const testPending=new Map();let testId=0;
    window.seegTestReject=(id,message)=>{const pending=testPending.get(id);if(pending){testPending.delete(id);pending.reject(new Error(message));}};
    window.seegTestResolve=(id,text,status,type)=>{const pending=testPending.get(id);if(pending){testPending.delete(id);pending.resolve(new Response(text,{status,headers:{'Content-Type':type}}));}};
    window.fetch=(url,options={})=>new Promise((resolve,reject)=>{const id=++testId;testPending.set(id,{resolve,reject});options.signal?.addEventListener('abort',()=>{testPending.delete(id);reject(new DOMException('Aborted','AbortError'));},{once:true});window.seegTestRequest(JSON.stringify({id,url:String(url),method:options.method||'GET',body:options.body}));});
    window.EventSource=class{constructor(url){this.closed=false;fetch(url).then(r=>r.text()).then(text=>{for(const block of text.split('\\n\\n')){if(this.closed)return;const line=block.split('\\n').find(x=>x.startsWith('data:'));if(line)this.onmessage?.({data:line.slice(5).trimStart()});}}).catch(e=>{if(!this.closed)this.onerror?.(e);});}close(){this.closed=true;}};
  `});
  let markup=await readFile(resolve(root,'frontend/index.html'),'utf8');
  for(const asset of [...markup.matchAll(/<script src="([^"]+)"><\/script>/g)]){
    const content=await readFile(resolve(root,'frontend',asset[1].split('?')[0].replace(/^\//,'')),'utf8');
    markup=markup.replace(asset[0],()=>'<script>'+content.replace(/<\/script/gi,'<\\/script')+'</script>');
  }
  markup=markup.replace(/<link rel="stylesheet" href="\/v3\.css(?:\?[^"]*)?">/,'<style>'+await readFile(resolve(root,'frontend/v3.css'),'utf8')+'</style>');
  for(const asset of [...markup.matchAll(/<img[^>]+src="(\/assets\/[^\"]+)"/g)]){
    const bytes=await readFile(resolve(root,'frontend',asset[1].slice(1)));
    const type=asset[1].endsWith('.jpg')?'image/jpeg':'image/png';
    markup=markup.replace(`src="${asset[1]}"`,`src="data:${type};base64,${bytes.toString('base64')}"`);
  }
  const localPage=resolve(profile,'app.html');await writeFile(localPage,markup);
  await call('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});
  await call('Page.navigate',{url:'file://'+localPage});
  await wait('window.v3OnState && typeof THREE !== "undefined"');
  const cleanView = () => check('visitor copy contains no implementation details', `!/(patient_info|clinical_summary|clinical\\.tsv|待补充|未提供诊断|补充病例报告|本地模型|Qwen|服务器|数据映射|智能分析|开始分析|AI 推理|预设目标)/i.test(document.body.innerText + [...document.querySelectorAll('[title]')].map(x=>x.title).join(' '))`);
  await cleanView();
  await capture('v3-home.png');
  await check('homepage contains only case import','!document.getElementById("browse-cases-btn") && !document.getElementById("sample-cases")');
  await check('official university logo loaded','document.getElementById("suat-logo").naturalWidth>0');
  await check('homepage footer left blank','!document.querySelector("#import-panel .import-footer") && !document.body.innerText.includes("完整病例资料，自动载入")');
  const doc=await call('DOM.getDocument');
  const input=await call('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#patient-json-input'});
  await call('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[resolve(root,'Patient_001/patient_info.json')]});
  await wait('currentState===APP_STATE.CONFIRM && document.getElementById("confirm-card").classList.contains("is-loading")');
  await check('five-stage import workflow visible','document.querySelectorAll("#case-workflow-steps li").length===5 && !document.getElementById("loading-thoughts-area").classList.contains("hidden")');
  await capture('v3-import-workflow.png');
  await wait('currentState===APP_STATE.CONFIRM && !document.getElementById("start-btn").disabled');
  await check('university logo remains visible after upload','getComputedStyle(document.querySelector(".university-brand")).display!=="none"');
  await check('upload retains Patient_001','patientId==="Patient_001"');
  await check('packaged report shown on the confirmation card',
    `v3Clinical.subject_id === ${JSON.stringify(firstReport.subject_id)} &&
     v3Clinical.report_text === ${JSON.stringify(firstReport.report_text)} &&
     document.querySelector("#patient-card .confirm-clinical p").textContent === v3Clinical.diagnosis`);
  await cleanView();
  await evaluate('document.getElementById("start-btn").click()');
  await wait('currentState===APP_STATE.PROMPT && v3Clinical.regions.length>0 && Object.keys(targetRegionMeshes).length===v3Clinical.regions.length');
  await check('import workflow complete and scene light','v3WorkflowStep===5 && scene.background.getHexString()==="f7f7fb" && getComputedStyle(document.querySelector(".university-brand")).display!=="none"');
  await check('planning needs replace generative analysis','!document.getElementById("analysis-mode") && !document.getElementById("supplemental-report") && document.getElementById("prompt-diagnosis").innerText.length>0 && document.getElementById("start-ai-btn").innerText.includes("开始术前分析")');
  await cleanView();
  await check('professional target title','document.querySelector(".prompt-title").textContent==="术前探测目标"');
  await capture('v3-patient001-input.png');
  await evaluate('document.getElementById("start-ai-btn").click()');
  await wait('v3StoryCache[patientId]?.steps.some(step => step.action === "highlight" && step.title === document.getElementById("story-step-title").textContent)');
  await capture('v3-target-highlights.png');
  await wait('v3Review?.phase==="reading"',120000);
  await evaluate('window.__readingObserved=performance.now()');
  await check('preoperative analysis finishes without electrodes','currentState===APP_STATE.PARSING && document.getElementById("analysis-output").textContent===v3StoryTranscript(v3StoryCache.Patient_001) && document.getElementById("analysis-review-text").textContent===v3StoryCache.Patient_001.steps.at(-1).text && electrodeMeshes.length===0 && entryPointMeshes.length===0 && implantPointMeshes.length===0 && Object.values(targetRegionMeshes).every(mesh=>mesh.visible)');
  await capture('v3-analysis-reading.png');
  await wait('currentState===APP_STATE.PLAN_SELECT');
  await check('planning story retained for twenty-second reading period','performance.now()-window.__readingObserved>=19000');
  await check('no electrode preview before choosing a plan','electrodeMeshes.length===0 && entryPointMeshes.length===0 && implantPointMeshes.length===0');
  await check('preoperative titles updated','document.querySelector(".analysis-review-heading h2").textContent.includes("术前分析") && !/规划讲解|逐根查看电极路径/.test(document.body.innerText)');
  await check('base and alternative candidate sizes', 'cachedPlans.A.electrodes.length===v3Clinical.regions.length && cachedPlans.B.electrodes.length===9 && cachedPlans.C.electrodes.length===11');
  await check('curated geometry retained',`(async()=>{for(const [id,n] of [['B',9],['C',11]]){const data=await fetch('/api/plan_override?patient_id=Patient_001&needle_count='+n).then(r=>r.json());const geometry=e=>[e.name,e.entry_point,e.implant_endpoint,e.direction];if(JSON.stringify(cachedPlans[id].electrodes.map(geometry))!==JSON.stringify(data.electrodes.map(geometry)))return false;}return true;})()`);
  await cleanView();
  await check('requested plan names','[cachedPlans.A,cachedPlans.B,cachedPlans.C].map(p=>p.tag).join(",")==="经济方案,平衡方案,精确方案" && document.querySelector(".plan-badge").textContent==="经济方案"');
  await check('candidate explanation area removed','!document.getElementById("plan-comparison-points") && !document.querySelector(".plan-selector-subtitle")');
  await capture('v3-candidate-plans.png');
  await evaluate('document.querySelectorAll(".plan-card")[1].click()');
  await wait('currentState===APP_STATE.INTERACT',90000);
  await check('implantation completes with 9 electrodes','sceneData.electrodes.length===9 && electrodeMeshes.length===9');
  await evaluate('document.querySelector(".plan-switch-btn[data-plan=C]").click()');
  await check('switch to curated 11 electrodes','currentPlanId==="C" && sceneData.electrodes.length===11 && electrodeMeshes.length===11');
  await capture('v3-interactive.png');
  await evaluate('document.getElementById("edit-plan-btn").click()');
  await check('manual edit controls','editing && !document.getElementById("edit-toolbar").classList.contains("hidden")');
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await evaluate('triggerResize()');
  await capture('v3-edit-light-1280.png');
  await check('light edit panels and persistent logo','getComputedStyle(document.querySelector("#edit-toolbar .edit-col")).backgroundColor.startsWith("rgba(255, 255, 255") && getComputedStyle(document.querySelector(".university-brand")).display!=="none"');
  await call('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});
  await evaluate('triggerResize()');
  await evaluate('document.getElementById("edit-cancel-btn").click()');
  await check('cancel returns to selected plan','!editing && currentPlanId==="C" && sceneData.electrodes.length===11');
  await evaluate('goHome();v3ConfirmPatient("Patient_002")');
  await wait('currentState===APP_STATE.CONFIRM && !document.getElementById("start-btn").disabled');
  await check('second packaged report loaded',
    `v3Clinical.subject_id === ${JSON.stringify(secondReport.subject_id)} &&
     v3Clinical.report_text === ${JSON.stringify(secondReport.report_text)}`);
  await evaluate('document.getElementById("start-btn").click()');
  await wait('currentState===APP_STATE.PROMPT && v3Clinical.regions.length>0 && Object.keys(targetRegionMeshes).length===v3Clinical.regions.length');
  await capture('v3-clinical-workspace.png');
  await evaluate('document.getElementById("start-ai-btn").click()');
  await wait('v3Review?.phase==="reading"',120000);
  await evaluate('document.getElementById("analysis-keep-reading").click()');
  await check('continue reading pauses automatic navigation','v3Review.paused && v3Review.phase==="paused" && currentState===APP_STATE.PARSING');
  await evaluate('new Promise(resolve=>setTimeout(resolve,21000))');
  await check('paused analysis remains after deadline','v3Review.paused && currentState===APP_STATE.PARSING');
  await capture('v3-analysis-paused.png');
  await evaluate('document.getElementById("analysis-view-plans").click()');
  await wait('currentState===APP_STATE.PLAN_SELECT',60000);
  await check('prepared story reaches candidates','document.getElementById("analysis-output").textContent===v3StoryTranscript(v3StoryCache.Patient_002) && !document.getElementById("plan-comparison-points") && !document.querySelector(".plan-selector-subtitle")');
  await cleanView();
  await capture('v3-planning-process.png');
  await evaluate('switchToPatient("Patient_001")');
  await wait('currentState===APP_STATE.INTERACT');
  await check('history restores curated plan and clinical context','patientId==="Patient_001" && currentPlanId==="C" && sceneData.electrodes.length===11 && v3Clinical.patient_id==="Patient_001"');
  await evaluate('goHome()');
  await check('home clears scene','currentState===APP_STATE.IMPORT && sceneData===null && renderer===null');
  await check('navigation clears reading timers','v3Review===null && v3Pending.size===0');
  if(requests.some(url=>/api\/(analysis|model_status|llm_parse_prompt)/.test(url)))throw new Error('Retired generative endpoint requested');
  results.push('no language model endpoints requested');
  if(errors.length)throw new Error(JSON.stringify(errors));
  await writeFile(resolve(root,'.runtime/browser_smoke.json'),JSON.stringify({status:'PASS',network:'local document + live backend via CDP binding; scene SSE buffered',results,requests,errors},null,2));
  console.log('PASS browser flow',results.length);
  await call('Browser.close');
} catch(error) {
  await writeFile(resolve(root,'.runtime/browser_smoke.json'),JSON.stringify({status:'FAIL',message:error.message,results,errors},null,2));
  console.error(error);process.exitCode=1;
} finally {
  socket?.close();if(browser.exitCode===null)browser.kill('SIGTERM');
  await writeFile(resolve(profile,'chrome.log'),browserLog);
}
