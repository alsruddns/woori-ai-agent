import React from 'react';

type Execution=Record<string,any>;
const stamp=(value?:string|null)=>value?new Date(value).toLocaleString('ko-KR'):'기록 없음';
const elapsed=(start?:string|null,finish?:string|null)=>start&&finish?`${((Date.parse(finish)-Date.parse(start))/1000).toFixed(1)}초`:'진행 중';

export function DevelopmentExecutions({rows}:{rows:Execution[]}){
 return <><h3>Codex 실행 및 검증 이력</h3><div className="finding-list">{rows.map(row=><article key={row.executionId}><span className="state">{row.status} · {row.mode}</span><div><b>{row.service} · {row.taskId}</b><p>인증 {row.authMode||'미확인'} · Codex {row.codexVersion||'미확인'} · 종료 코드 {row.exitCode??'—'} · 시작 {stamp(row.startedAt)} · 종료 {stamp(row.finishedAt)} · 소요 {elapsed(row.startedAt,row.finishedAt)}</p><p>작업 브랜치: {row.branchName||'없음'} · 변경 파일: {(row.changedFiles||[]).join(', ')||'없음'}</p><small>{row.errorReason||JSON.stringify(row.verification||{})}</small></div></article>)}{rows.length===0&&<div className="empty card">Codex 실행 기록이 없습니다. Ready 상태, 서비스별 opt-in, 명시적 1회 승인, 파일 범위 허용이 모두 필요합니다.</div>}</div></>;
}
