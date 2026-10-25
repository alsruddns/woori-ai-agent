import{useEffect,useState}from'react';
import{VirtualizedList}from'./VirtualizedList';
import{VirtualizedTable}from'./VirtualizedTable';

type Item=Record<string,any>;
type FilterState={service:string;kind:string;status:string;agent:string;worker:string;pr:string;commit:string;from:string;to:string};
const emptyFilters:FilterState={service:'',kind:'',status:'',agent:'',worker:'',pr:'',commit:'',from:'',to:''};
const stamp=(value?:string)=>value?new Date(value).toLocaleString('ko-KR'):'기록 없음';

export function DevelopmentHistory(){
 const[data,setData]=useState<any>(),[filters,setFilters]=useState(emptyFilters),[page,setPage]=useState(1),[selected,setSelected]=useState<Item|null>(null),[error,setError]=useState('');
 async function load(){try{const q=new URLSearchParams({page:String(page),pageSize:'15'});for(const[key,value]of Object.entries(filters))if(value)q.set(key,value);const r=await fetch('/api/development/history?'+q);if(!r.ok)throw new Error('감사 이력을 불러오지 못했습니다.');setData(await r.json());setError('')}catch(e){setError(String(e))}}
 useEffect(()=>{void load()},[page,filters]);
 async function detail(id:string){try{const r=await fetch('/api/development/history/'+encodeURIComponent(id));if(!r.ok)throw new Error('작업 상세를 불러오지 못했습니다.');setSelected(await r.json())}catch(e){setError(String(e))}}
 function update<K extends keyof FilterState>(key:K,value:FilterState[K]){setPage(1);setFilters(current=>({...current,[key]:value}))}
 const jobs:Item[]=data?.jobs?.items??[],features:Item[]=data?.features?.items??[];
 return <section id="development-history"><div className="section-title"><div><h2>Development History</h2><p>Append-only 이벤트 원장 · 기록된 증거만 표시 · 자동 수정·PR·병합·배포는 비활성화</p></div></div>
  {error&&<div className="error" role="alert">{error}</div>}
  <div className="filters history-filters">
   <label>서비스<select value={filters.service} onChange={e=>update('service',e.target.value)}><option value="">전체</option>{['home','calculator','tools','docs','quiz','money'].map(x=><option key={x}>{x}</option>)}</select></label>
   <label>작업 유형<select value={filters.kind} onChange={e=>update('kind',e.target.value)}><option value="">전체</option>{['Bug Fix','Feature','Improvement','SEO','Localization','Maintenance'].map(x=><option key={x}>{x}</option>)}</select></label>
   <label>상태<input value={filters.status} onChange={e=>update('status',e.target.value)} placeholder="Running / Failed"/></label><label>Agent<input value={filters.agent} onChange={e=>update('agent',e.target.value)}/></label><label>Worker<input value={filters.worker} onChange={e=>update('worker',e.target.value)}/></label>
   <label>PR 번호<input value={filters.pr} onChange={e=>update('pr',e.target.value)}/></label><label>Commit SHA<input value={filters.commit} onChange={e=>update('commit',e.target.value)}/></label><label>시작일<input type="date" value={filters.from} onChange={e=>update('from',e.target.value)}/></label><label>종료일<input type="date" value={filters.to} onChange={e=>update('to',e.target.value)}/></label>
   <span>{data?.jobs?.total??0}개 작업 · 서버 페이지 {page}</span>
  </div>
  <VirtualizedTable rows={jobs} ariaLabel="Development History 작업" getRowKey={x=>x.jobUuid} height={480} virtualizeFrom={40} emptyState="기록된 개발 작업이 없습니다. 실제 작업 데이터만 표시합니다." columns={[
   {key:'createdAt',label:'생성 시각',width:'180px',render:x=>stamp(x.createdAt)},
   {key:'jobId',label:'작업 ID',width:'160px',render:x=><button className="link-button" onClick={()=>void detail(x.jobId)}>{x.jobId}</button>},
   {key:'service',label:'서비스',width:'110px',render:x=>x.service},{key:'kind',label:'유형',width:'130px',render:x=>x.kind},
   {key:'reason',label:'이유',render:x=><span className="cell-clamp" title={x.reason}>{x.reason}</span>},{key:'status',label:'상태',width:'120px',render:x=>x.status},{key:'risk',label:'위험',width:'100px',render:x=>x.risk}
  ]}/>
  <div className="table-pager"><span>{data?.jobs?.total??0}개 중 페이지 {page}</span><button disabled={page<=1} onClick={()=>setPage(value=>value-1)}>이전</button><button disabled={!data||page*data.jobs.pageSize>=data.jobs.total} onClick={()=>setPage(value=>value+1)}>다음</button></div>
  <h3>Feature Release History</h3>
  <VirtualizedTable rows={features} ariaLabel="Feature Release History" getRowKey={x=>x.featureId} height={420} virtualizeFrom={40} emptyState="출시 기록 없음. 확인되지 않은 출시는 생성하지 않습니다." columns={[
   {key:'firstRecordedAt',label:'최초 기록',width:'180px',render:x=>stamp(x.firstRecordedAt)},{key:'featureId',label:'기능 ID',width:'210px',render:x=>x.featureId},{key:'service',label:'서비스',width:'110px',render:x=>x.service},{key:'name',label:'기능',render:x=>x.name},{key:'status',label:'상태',width:'120px',render:x=>x.status},{key:'locales',label:'언어',render:x=><span className="cell-clamp" title={x.locales?.join(', ')}>{x.locales?.join(', ')||'Unknown'}</span>},{key:'urls',label:'URL · 출시 증거',render:x=><details><summary className="cell-clamp">{x.urls?.join(', ')||'Unknown'} · 증거</summary><pre>{JSON.stringify(x.evidence,null,2)}</pre></details>}
  ]}/>
  {selected&&<div className="drawer-backdrop" onClick={()=>setSelected(null)}><aside className="drawer" onClick={e=>e.stopPropagation()}><button className="close" onClick={()=>setSelected(null)}>닫기</button><h2>{selected.jobId} · {selected.title}</h2><p>{selected.service} · {selected.kind} · {selected.status} · Controller Policy v{selected.policyVersion}</p><p>시작 이유: {selected.reason}</p><p>Hash chain: {selected.chain?.valid?'Valid':'Invalid'} · 이벤트 {selected.chain?.events??0}개</p><h3>사건 이력</h3><VirtualizedList items={selected.events??[]} ariaLabel="개발 작업 감사 이벤트" getItemKey={ev=>ev.eventId} height={Math.min(600,window.innerHeight-180)} estimateSize={110} virtualizeFrom={30} renderItem={(ev:Item)=><article className="detail-row"><b>#{ev.sequence} {ev.type}</b><small>{stamp(ev.timestamp)} · {ev.actor} · Policy v{ev.policyVersion}</small><details><summary>이벤트 데이터</summary><pre>{JSON.stringify(ev.payload,null,2)}</pre></details></article>}/></aside></div>}
  <p className="note">{data?.migration} 이벤트는 SHA-256 연결로 우발 변경을 감지합니다. 호스트 관리자 변경을 방지하는 보안 경계는 아닙니다.</p>
 </section>
}
