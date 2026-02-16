import crypto from "crypto";
import fs from "fs";
import path from "path";

const COOKIE_NAME = "amtrak_session";
const ONE_DAY = 24 * 60 * 60;

function base64url(buf){
  return Buffer.from(buf).toString("base64").replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
}
function unbase64url(str){
  str = str.replace(/-/g,"+").replace(/_/g,"/");
  while(str.length % 4) str += "=";
  return Buffer.from(str, "base64");
}
function sign(data, secret){
  return base64url(crypto.createHmac("sha256", secret).update(data).digest());
}
export function makeToken(payload, secret){
  const body = base64url(JSON.stringify(payload));
  const sig = sign(body, secret);
  return `${body}.${sig}`;
}
export function verifyToken(token, secret){
  if(!token) return null;
  const parts = token.split(".");
  if(parts.length !== 2) return null;
  const [body, sig] = parts;
  if(sign(body, secret) !== sig) return null;
  const payload = JSON.parse(unbase64url(body).toString("utf-8"));
  if(payload.exp && Math.floor(Date.now()/1000) > payload.exp) return null;
  return payload;
}
export function parseCookies(req){
  const h = req.headers.cookie || "";
  const out = {};
  h.split(";").forEach(part=>{
    const i = part.indexOf("=");
    if(i===-1) return;
    const k = part.slice(0,i).trim();
    const v = part.slice(i+1).trim();
    out[k]=decodeURIComponent(v);
  });
  return out;
}
export function setCookie(res, value, maxAge){
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if(maxAge !== undefined) attrs.push(`Max-Age=${maxAge}`);
  // If you add a custom domain + https, Vercel will set secure; keep off for localhost dev
  if(process.env.VERCEL) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}
export function clearCookie(res){
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${process.env.VERCEL ? "; Secure": ""}`);
}
export function getSecret(){
  return process.env.SESSION_SECRET || "dev_insecure_secret_change_me";
}
export function loadAccounts(){
  const fp = new URL("./accounts.json", import.meta.url);
  return JSON.parse(fs.readFileSync(fp, "utf-8"));
}
export function verifyPassword(acct, password){
  // supports legacy plaintext: {password:"..."}
  if(acct && typeof acct.password === "string"){
    return acct.password === password;
  }
  // supports pbkdf2_sha256: {algo:"pbkdf2_sha256", salt, iter, dklen, hash}
  if(!acct || acct.algo !== "pbkdf2_sha256") return false;
  const salt = acct.salt || "";
  const iter = acct.iter || 200000;
  const dklen = acct.dklen || 32;
  const derived = crypto.pbkdf2Sync(
    Buffer.from(password, "utf-8"),
    Buffer.from(salt, "utf-8"),
    iter,
    dklen,
    "sha256"
  );
  const digest = base64url(derived);
  return digest === acct.hash;
}


export function json(res, status, obj){
  res.statusCode = status;
  res.setHeader("Content-Type","application/json; charset=utf-8");
  res.setHeader("Cache-Control","no-store");
  res.end(JSON.stringify(obj));
}
export function requireAuth(req, res){
  const cookies = parseCookies(req);
  const tok = cookies[COOKIE_NAME];
  const payload = verifyToken(tok, getSecret());
  if(!payload){
    json(res, 401, {error:"not_logged_in"});
    return null;
  }
  return payload;
}
