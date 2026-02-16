import { requireAuth, json } from "../_lib.js";

const UPSTREAM = "https://api-v3.amtraker.com/v3/trains";

export default async function handler(req,res){
  const p = requireAuth(req,res);
  if(!p) return;

  try{
    const r = await fetch(UPSTREAM, { headers: { "User-Agent": "amtrak-board-vercel-proxy" }});
    const text = await r.text();
    res.statusCode = r.status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    // same-origin in Vercel, but add permissive CORS for safety
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(text);
  }catch(e){
    return json(res, 502, {error:"upstream_failed", detail:String(e)});
  }
}
