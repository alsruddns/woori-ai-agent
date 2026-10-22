import {execFileSync} from 'node:child_process';

function invoke(script:string,value:string){
 if(process.platform!=='win32')throw new Error('Local DPAPI storage is available only on Windows.');
 return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{input:value,encoding:'utf8',windowsHide:true}).trim();
}
export function protectForCurrentWindowsUser(value:string){
 return invoke("$v=[Console]::In.ReadToEnd();$s=ConvertTo-SecureString -String $v -AsPlainText -Force;ConvertFrom-SecureString -SecureString $s",value);
}
export function unprotectForCurrentWindowsUser(value:string){
 return invoke("$v=[Console]::In.ReadToEnd().Trim();$s=ConvertTo-SecureString $v;$c=New-Object System.Management.Automation.PSCredential('local',$s);$c.GetNetworkCredential().Password",value);
}
