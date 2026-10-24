import fs from 'node:fs';
import path from 'node:path';

const root=process.cwd();
const required=['deploy/linux/install.sh','deploy/linux/manage.sh','deploy/linux/package.sh','deploy/systemd/woori-agent-controller.service','deploy/systemd/woori-agent-scheduler.service','deploy/systemd/woori-agent-worker.service','deploy/systemd/woori-agent-dashboard.service','deploy/systemd/woori-agent-backup.service','deploy/systemd/woori-agent-backup.timer','deploy/systemd/woori-agent-controller.slice','deploy/systemd/woori-agent-worker.slice'];
for(const file of required)if(!fs.existsSync(path.join(root,file)))throw new Error(`Missing Linux deployment file: ${file}`);
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
if(!read('deploy/linux/install.sh').includes('run_preflight')||!read('deploy/linux/install.sh').includes('cgroup v2'))throw new Error('Installer preflight checks are incomplete.');
const controller=read('deploy/systemd/woori-agent-controller.slice'),worker=read('deploy/systemd/woori-agent-worker.slice');
for(const [name,text] of [['controller',controller],['worker',worker]])for(const directive of ['CPUQuota=50%','MemoryAccounting=true','TasksMax='])if(!text.includes(directive))throw new Error(`${name} slice misses ${directive}`);
if(!controller.includes('MemoryMax=384M')||!worker.includes('MemoryMax=256M'))throw new Error('Slice memory caps do not match the reviewed initial budget.');
for(const name of ['controller','scheduler','worker','dashboard','backup']){
 const unit=read(`deploy/systemd/woori-agent-${name}.service`);
 for(const directive of ['NoNewPrivileges=true','ProtectSystem=strict','ProtectHome=true','PrivateTmp=true','KillMode=control-group'])if(!unit.includes(directive))throw new Error(`${name} unit misses ${directive}`);
 if(/docker\.sock|\/var\/run\/docker|ExecStart=.*(codex|playwright|lighthouse)/i.test(unit))throw new Error(`${name} unit contains a forbidden runtime access or workload.`);
 if(name==='controller'&&!unit.includes('Slice=woori-agent-controller.slice'))throw new Error('Controller must be inside the shared resource slice.');
 if(name==='scheduler'&&(!unit.includes('Slice=woori-agent-controller.slice')||!unit.includes('ConditionPathExists=/etc/woori-ai-agent/scheduler.enabled')))throw new Error('Scheduler must share the capped slice and remain opt-in.');
 if(name==='worker'&&!unit.includes('Slice=woori-agent-worker.slice'))throw new Error('Worker must use its dedicated capped slice.');
}
for(const name of ['controller','scheduler','dashboard','worker'])if(!read(`deploy/linux/env/${name}.env.example`).includes('AI_API_BUDGET_USD=0'))throw new Error(`${name} environment template is missing zero-cost policy.`);
if(read('deploy/linux/env/scheduler.env.example').includes('WOORI_SCHEDULER_ENABLED=true'))throw new Error('Scheduler must default OFF.');
if(!read('apps/cli/src/server.ts').includes("server.listen(port,'127.0.0.1'"))throw new Error('Dashboard API must remain loopback-only.');
console.log(`Linux deployment static checks passed (${required.length} package/unit files). Kernel isolation is not inferred from static files.`);
