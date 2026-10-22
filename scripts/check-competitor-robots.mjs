import {readFile} from 'node:fs/promises';

const config=JSON.parse(await readFile('configs/competitor-candidates.json','utf8'));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
for(const candidate of config.candidates){
  const url=new URL('/robots.txt',candidate.url);
  let result;
  try{
    const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(8000),headers:{'user-agent':'WooriSiteIntelligence/0.1 (read-only; robots status check)'}});
    result={id:candidate.id,robotsUrl:url.href,status:response.status,accessible:response.ok,homepageFetched:false,termsReviewed:false,crawlEnabled:false};
  }catch(error){result={id:candidate.id,robotsUrl:url.href,status:'Unavailable',reason:String(error),homepageFetched:false,termsReviewed:false,crawlEnabled:false};}
  console.log(JSON.stringify(result));
  await delay(Math.max(1500,config.requestDelayMs));
}
