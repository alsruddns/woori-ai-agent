export type GithubCheckEvidence={name:string;state:string;conclusion:string|null;url?:string|null;workflow?:string|null;headSha?:string|null;source:'check_run'|'commit_status'|'workflow_run'};
export type GithubWorkflowEvidence={runId:number;name:string;status:string;conclusion:string|null;url:string|null;createdAt:string|null;headSha:string};
export type CiAssessment={status:'Passed'|'Failed'|'In Progress'|'Not Configured'|'Query Failed'|'Checks Missing'|'Cancelled'|'Timed Out'|'Stale';currentSha:string;requiredChecks:string[];checks:GithubCheckEvidence[];workflowRuns:GithubWorkflowEvidence[];missingRequired:string[];staleEvidence:number;reason:string};

const normalized=(value:string)=>value.trim().toLowerCase().replace(/\s+/g,' ');
const conclusionOf=(item:{state:string;conclusion:string|null})=>(item.conclusion??item.state).toUpperCase().replace(/[- ]/g,'_');

/** CI passes only when current-head evidence satisfies a non-empty set of configured required checks. */
export function assessGithubCi(input:{currentSha:string;requiredChecks?:string[];requiredChecksConfigured:boolean;checks?:GithubCheckEvidence[];workflowRuns?:GithubWorkflowEvidence[];queryFailed?:boolean}):CiAssessment{
 const currentSha=input.currentSha;
 const allChecks=input.checks??[];
 const staleChecks=allChecks.filter(item=>item.headSha&&item.headSha!==currentSha);
 const checks=allChecks.filter(item=>!item.headSha||item.headSha===currentSha);
 const workflowRuns=(input.workflowRuns??[]).filter(run=>run.headSha===currentSha);
 const requiredChecks=[...new Set((input.requiredChecks??[]).map(value=>value.trim()).filter(Boolean))];
 const missingRequired=requiredChecks.filter(required=>!checks.some(check=>normalized(check.name)===normalized(required)));
 const base={currentSha,requiredChecks,checks,workflowRuns,missingRequired,staleEvidence:staleChecks.length};
 if(input.queryFailed)return{...base,status:'Query Failed',reason:'GitHub checks or branch protection could not be queried; approval remains blocked.'};
 if(staleChecks.length&&checks.length===0&&workflowRuns.length===0)return{...base,status:'Stale',reason:'Only CI evidence for an older commit was observed.'};
 if(!input.requiredChecksConfigured||requiredChecks.length===0)return{...base,status:'Not Configured',reason:'The target branch has no configured required checks; CI cannot qualify this PR for approval.'};
 if(missingRequired.length)return{...base,status:'Checks Missing',reason:`Required checks are missing for the current PR head: ${missingRequired.join(', ')}.`};
 const relevant=checks.filter(check=>requiredChecks.some(required=>normalized(required)===normalized(check.name)));
 const outcomes=relevant.map(conclusionOf);
 if(outcomes.some(value=>value==='TIMED_OUT'))return{...base,status:'Timed Out',reason:'At least one required check timed out.'};
 if(outcomes.some(value=>value==='CANCELLED' || value==='CANCELED'))return{...base,status:'Cancelled',reason:'At least one required check was cancelled.'};
 if(outcomes.some(value=>['FAILURE','ERROR','ACTION_REQUIRED','STARTUP_FAILURE'].includes(value)))return{...base,status:'Failed',reason:'At least one required check failed.'};
 if(outcomes.some(value=>['QUEUED','IN_PROGRESS','PENDING','EXPECTED','REQUESTED','WAITING'].includes(value)))return{...base,status:'In Progress',reason:'One or more required checks are still running.'};
 if(outcomes.length===requiredChecks.length&&outcomes.every(value=>['SUCCESS','NEUTRAL','SKIPPED'].includes(value)))return{...base,status:'Passed',reason:'All configured required checks succeeded for the current PR head SHA.'};
 return{...base,status:'Checks Missing',reason:'Required check evidence is incomplete or has an unrecognized state.'};
}
