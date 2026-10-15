import { build } from 'esbuild';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const label =
  process.argv.find((argument) => argument.startsWith('--label='))?.slice(8) ?? 'current';
const seconds = Number(
  process.argv.find((argument) => argument.startsWith('--seconds='))?.slice(10) ?? 60,
);
if (!Number.isFinite(seconds) || seconds < 5 || seconds > 60)
  throw new Error('Use --seconds=5..60.');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'harness-benchmark-'));
try {
  const bundle = path.join(temporary, 'search.cjs');
  await build({
    entryPoints: [path.join(root, 'packages/search/index.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  const worker = new Worker(
    `
    const {parentPort,workerData}=require('node:worker_threads');
    const {performance}=require('node:perf_hooks');
    const {createHash}=require('node:crypto');
    const {SearchIndex,emptyIndex}=require(workerData.bundle);
    const start=performance.now(), state=emptyIndex();
    const result={label:workerData.label,status:'running',documents:0,chunks:0,sourceBytes:0,indexingMs:0,keywordMs:[],hybridMs:[],mockVectorBuildMs:0,elapsedMs:0,memory:{},stage:'corpus'};
    function report(){result.elapsedMs=performance.now()-start;const memory=process.memoryUsage();result.memory={rssBytes:memory.rss,heapUsedBytes:memory.heapUsed};parentPort.postMessage(result);}
    const digest=text=>createHash('sha256').update(text).digest();
    const embedding=text=>{const bytes=digest(text);const v=Array.from({length:8},(_,i)=>(bytes[i]-127.5)/127.5);const norm=Math.hypot(...v);return v.map(x=>x/norm);};
    const vocabulary=['sem_timedwait','foo::bar','watchdog','교착상태','재현 절차','동기화 오류','회귀 검사','락 순서'];
    const queries=Array.from({length:30},(_,i)=>i%3===0?vocabulary[i%8]:i%3===1?'#'+(1000+i*13):'project_'+(i%10)+' '+vocabulary[(i+3)%8]);
    (async()=>{
      const sources=new Map();
      const deps={canRead:()=>true,canEmbed:()=>true,canEmbedQuery:()=>true,verify:async source=>sources.get(source.id)?.hash===source.hash};
      const keyword=new SearchIndex(state,deps);
      for(let i=0;i<5000;i++){
        const text=Array.from({length:8},(_,section)=>'# Section '+section+'\\nSynthetic record '+i+' project_'+(i%10)+' #'+(1000+i)+' '+vocabulary[section]+'. 한국어 업무 기록. 검증 결과를 확인했다.\\n').join('\\n');
        const document={id:'synthetic:'+i,kind:'vault',uri:'obsidian://open?path=Synthetic%2F'+i+'.md',path:'Synthetic/Project'+(i%10)+'/'+i+'.md',title:'Synthetic '+i,hash:digest(text).toString('hex'),updatedAt:1792022400000,indexedAt:1792022400000,text,project:'Project'+(i%10),tags:['synthetic']};
        sources.set(document.id,document);await keyword.upsert(document);result.sourceBytes+=Buffer.byteLength(text);result.documents=state.documents.length;result.chunks=state.chunks.length;
        if(i%500===499)report();
      }
      result.indexingMs=performance.now()-start;result.stage='keyword warmup';report();
      for(let i=0;i<2;i++)await keyword.search(queries[i]);
      result.stage='keyword samples';
      for(const query of queries){const at=performance.now();await keyword.search(query);result.keywordMs.push(performance.now()-at);report();}
      const model={key:'synthetic-hash@1',dimensions:8,embed:async texts=>texts.map(embedding)};
      const hybrid=new SearchIndex(state,{...deps,embedding:model});
      const vectorStart=performance.now();await hybrid.invalidatePolicy();
      // Synthetic fixture vectors avoid timing network/provider/indexing I/O as if it were search.
      for(const chunk of state.chunks){chunk.vector=embedding(chunk.text);chunk.embeddingKey=state.embeddingKey;}
      result.mockVectorBuildMs=performance.now()-vectorStart;result.stage='hybrid warmup';report();
      for(let i=0;i<2;i++)await hybrid.search(queries[i]);
      result.stage='hybrid samples';
      for(const query of queries){const at=performance.now();const response=await hybrid.search(query);if(response.mode!=='hybrid')throw Error('Expected hybrid fixture');result.hybridMs.push(performance.now()-at);report();}
      result.status='completed';result.stage='done';report();
    })().catch(error=>{result.status='failed';result.stage='error';result.error=String(error?.message??error);report();});
  `,
    { eval: true, workerData: { bundle, label } },
  );
  let latest = {
    label,
    status: 'starting',
    documents: 0,
    chunks: 0,
    sourceBytes: 0,
    indexingMs: 0,
    keywordMs: [],
    hybridMs: [],
    elapsedMs: 0,
    memory: {},
    stage: 'starting',
  };
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(async () => {
      await worker.terminate();
      resolve({ ...latest, status: 'time-limit', elapsedMs: seconds * 1000 });
    }, seconds * 1000);
    worker.on('message', (message) => {
      latest = message;
      if (message.status === 'completed' || message.status === 'failed') {
        clearTimeout(timer);
        void worker.terminate();
        resolve(message);
      }
    });
    worker.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  const metrics = (values) => {
    if (!values.length) return { samples: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    return {
      samples: values.length,
      p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      maxMs: sorted.at(-1),
    };
  };
  const summary = {
    ...result,
    keyword: metrics(result.keywordMs),
    hybrid: metrics(result.hybridMs),
    runtime: process.version,
    platform: `${process.platform}/${process.arch}`,
    cpu: os.cpus()[0]?.model,
  };
  delete summary.keywordMs;
  delete summary.hybridMs;
  console.log(JSON.stringify(summary, null, 2));
  const out = path.join(root, 'docs', 'benchmark-results.md');
  let previous = '';
  try {
    previous = await readFile(out, 'utf8');
  } catch {}
  const header =
    '# Synthetic Search Benchmark\n\n실제 업무 자료, 자격 증명, 외부 API, Obsidian 앱을 사용하지 않는 재현 가능한 모듈 벤치마크다. `node scripts/benchmark.mjs --label=current`로 실행한다. 5,000개 합성 Markdown 문서를 증분 upsert하여 제목당 8개 조각을 만든다. 한국어·코드 식별자·이슈 번호 질의 30개를 동일한 순서로 실행한다. 검색 방식별 2회 예열 후 실제 `SearchIndex.search`를 측정한다. 읽기·전송 정책과 최신 해시 검증 콜백도 실행한다. 영속 파일 저장 콜백은 주입하지 않는다.\n\n하이브리드는 SHA-256에서 만든 결정적인 8차원 mock 벡터를 fixture에 공급한다. 검색 query embedding도 같은 순수 함수이다. 의미 검색 품질, 실제 임베딩 모델 지연, 네트워크, Obsidian 렌더링, 전체 앱 CPU/RSS, 색인 DB 영속 I/O 성능의 측정값이 아니다. RSS는 worker와 부모를 포함하는 Node 프로세스 값이며 heap은 worker 값이다. P95는 nearest-rank 방식이다. 기본 작업 제한은 60초이며 제한에 도달하면 완료된 표본만 표시하고 추정하지 않는다.\n';
  const number = (n) => (n === undefined ? '미측정' : n.toFixed(2));
  const block = `\n## ${label}\n\n- 상태: ${summary.status}${summary.status === 'time-limit' ? ` (${summary.stage}에서 ${seconds}초 상한)` : ''}\n- 실행 환경: ${summary.runtime}, ${summary.platform}, ${summary.cpu}\n- 합성 문서: ${summary.documents.toLocaleString()}개 / 조각: ${summary.chunks.toLocaleString()}개 / 원문 UTF-8: ${summary.sourceBytes.toLocaleString()} bytes\n- 증분 분할·색인 구성: ${number(summary.indexingMs)} ms\n- mock 벡터 fixture 구성: ${number(summary.mockVectorBuildMs)} ms\n- 전체 worker 경과: ${number(summary.elapsedMs)} ms\n- RSS: ${number(summary.memory.rssBytes / 1048576)} MiB / worker heap: ${number(summary.memory.heapUsedBytes / 1048576)} MiB\n\n| 방식 | 완료 표본 | P50 (ms) | P95 (ms) | 최대 (ms) |\n|---|---:|---:|---:|---:|\n| 키워드 | ${summary.keyword.samples}/30 | ${number(summary.keyword.p50Ms)} | ${number(summary.keyword.p95Ms)} | ${number(summary.keyword.maxMs)} |\n| 하이브리드 mock | ${summary.hybrid.samples}/30 | ${number(summary.hybrid.p50Ms)} | ${number(summary.hybrid.p95Ms)} | ${number(summary.hybrid.maxMs)} |\n\n${summary.error ? `오류: ${summary.error}\n` : ''}`;
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, (previous || header) + block);
  if (summary.status === 'failed') process.exitCode = 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
