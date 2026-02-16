import { requireAuth, json } from "../_lib.js";
export default async function handler(req,res){
  const p = requireAuth(req,res);
  if(!p) return;
  return json(res, 200, {ok:true, user:p.u, routes:p.routes, filters:p.filters});
}
