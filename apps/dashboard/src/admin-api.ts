export async function adminFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const csrf=document.cookie.split(';').map(item=>item.trim()).find(item=>item.startsWith('woori_agent_csrf='))?.split('=').slice(1).join('=');
  const headers=new Headers(init.headers); if(init.body){headers.set('content-type','application/json');if(csrf)headers.set('x-csrf-token',decodeURIComponent(csrf));}
  return fetch(input,{...init,headers,credentials:'same-origin'});
}
