import React from 'react';

type Props = { data?: Record<string, any> };
const date = (value?: string | null) => value ? new Date(value).toLocaleString('ko-KR') : '기록 없음';
const stateLabel = (value?: string) => ({online:'온라인',idle:'대기 중',busy:'작업 중',degraded:'성능 저하',offline:'오프라인',disabled:'비활성화',queued:'대기열',running:'실행 중',completed:'완료',failed:'실패',leased:'작업 할당',testing:'검사 중',blocked:'차단',claimed:'작업 할당',cancelled:'취소됨'} as Record<string,string>)[value?.toLowerCase()??'']??value??'확인 불가';
const countLabel = (key: string) => ({workers:'전체 Worker',onlineWorkers:'온라인 Worker',queued:'대기 작업',active:'진행 중 작업',completed:'완료 작업',failed:'실패 작업'} as Record<string,string>)[key]??key;
const configLabel = (value?: string) => ({ready:'준비됨',blocked:'차단',notconfigured:'설정 안 됨','not configured':'설정 안 됨',unknown:'확인 불가',available:'사용 가능',disabled:'비활성화',authenticated:'로그인됨',unauthenticated:'로그인 안 됨',unsupported:'미지원',error:'오류'} as Record<string,string>)[value?.toLowerCase()??'']??value??'확인 불가';

export function DistributedWorkers({ data }: Props) {
 const workers = data?.workers ?? [], jobs = data?.jobs ?? [], events = data?.events ?? [];
 return <section id="distributed-workers">
  <div className="section-title"><div><h2>분산 Controller 및 Worker</h2><p>중앙 SQLite Controller · 실제 Heartbeat 기록만 활성으로 표시 · Linux 코드 수정은 잠금 · 코드 실행은 이 화면에서 시작하지 않습니다.</p></div></div>
  <div className="stats">
   {Object.entries(data?.counts ?? { workers: 0, onlineWorkers: 0, queued: 0, active: 0, completed: 0, failed: 0 }).map(([key, value]) => <article key={key}><small>{countLabel(key)}</small><h2>{String(value)}</h2><p>Controller 저장 데이터</p></article>)}
  </div>
  <p className="note">Controller: {configLabel(data?.controller)} · Worker 등록: {configLabel(data?.workerRegistration)} · 상태 갱신 {date(data?.checkedAt)} · SQLite는 Controller 호스트의 로컬 파일이며 네트워크 파일 공유를 사용하지 않습니다.</p>
  <div className="table-wrap"><table><thead><tr><th>Worker</th><th>OS</th><th>상태</th><th>Heartbeat</th><th>작업</th><th>CPU / 여유 메모리</th><th>Codex / 로그인 / Sandbox</th></tr></thead><tbody>
   {workers.map((worker: Record<string, any>) => <tr key={worker.workerId}><td>{worker.workerId}<br/><small>{worker.hostLabel}</small></td><td>{worker.os==='Windows'?'Windows':worker.os==='Linux'?'Linux':worker.os}</td><td>{stateLabel(worker.state)}</td><td>{date(worker.heartbeatAt)}</td><td>{worker.currentJobId ?? '없음'}<br/><small>{stateLabel(worker.executionStatus)}</small></td><td>{worker.cpuCount} CPU / {Math.round((worker.availableMemoryBytes ?? 0) / 1024 / 1024)} MiB</td><td>Codex {configLabel(worker.codexCliStatus)} / 로그인 {configLabel(worker.chatgptLoginStatus)} / 격리 {configLabel(worker.sandboxStatus)}<br/><small>코드 변경 Claim: {worker.allowCodeChanges?'Controller 허용':'차단'} · 오류: {worker.lastErrorCode??'없음'}</small></td></tr>)}
   {!workers.length && <tr><td colSpan={7} className="empty">Worker Heartbeat가 아직 없습니다. 연결 전에는 Offline으로 취급합니다.</td></tr>}
  </tbody></table></div>
  <h3>중앙 작업 큐</h3><div className="table-wrap"><table><thead><tr><th>Global Job</th><th>서비스 / 유형</th><th>상태</th><th>Worker</th><th>Fencing Token</th><th>Lease 만료</th></tr></thead><tbody>
   {jobs.slice(0, 50).map((job: Record<string, any>) => <tr key={job.globalJobId}><td>{job.globalJobId}<br/><small>로컬 작업: {job.localTaskId ?? '수동'}</small></td><td>{job.service} / {job.workClass}<br/><small>{job.title}</small></td><td>{stateLabel(job.status)}</td><td>{job.workerId ?? '미할당'}</td><td>{job.fencingToken ?? '—'}</td><td>{job.expiresAt ? `${date(job.expiresAt)} (${Math.max(0, Math.round((Date.parse(job.expiresAt) - Date.now()) / 1000))}초)` : '—'}</td></tr>)}
   {!jobs.length && <tr><td colSpan={6} className="empty">중앙 큐에 저장된 작업이 없습니다.</td></tr>}
  </tbody></table></div>
  <details><summary>최근 중앙 작업 이벤트 ({events.length})</summary><ul>{events.slice(0, 25).map((item: Record<string, any>) => <li key={item.id}>{date(item.createdAt)} · {item.event} · {item.globalJobId ?? 'Worker'} · Fencing Token {item.fencingToken ?? '—'}</li>)}</ul></details>
 </section>;
}
