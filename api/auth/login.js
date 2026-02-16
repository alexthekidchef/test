import { loadAccounts, getSecret, makeToken, setCookie, json, verifyPassword } from "./_lib.js";

async function readBody(req){
  // Vercel may provide req.body already
  if(req.body){
    if(typeof req.body === "string"){
      try { return JSON.parse(req.body); } catch { return {}; }
    }
    if(typeof req.body === "object") return req.body;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  try { return JSON.parse(body || "{}"); } catch { return {}; }
}

export default async function handler(req, res){
  if(req.method !== "POST"){
    res.setHeader("Allow","POST");
    return json(res, 405, {error:"method_not_allowed"});
  }
  const data = await readBody(req);
  const { username, password } = data;
  let accounts;
  try{ accounts = loadAccounts(); }catch(e){ return json(res, 500, {error:"accounts_load_failed", detail:String(e)}); }

  const acct = accounts[username];
  if(!acct || !verifyPassword(acct, password)){
    return json(res, 401, {error:"bad_credentials"});
  }
  const now = Math.floor(Date.now()/1000);
  const payload = {
    u: username,
    routes: acct.routes || ["*"],
    filters: acct.filters || {},
    exp: now + 7*24*60*60
  };
  const tok = makeToken(payload, getSecret());
  setCookie(res, tok, 7*24*60*60);
  return json(res, 200, {ok:true, user: username, filters: payload.filters, routes: payload.routes});
}
