// --- Login background slideshow ---
const LOGIN_BACKGROUNDS = ["assets/login_bg/Autumn - Adirondack.jpg", "assets/login_bg/Autumn - Heartland Flyer.jpg", "assets/login_bg/Autumn - Missouri River Runner.jpg", "assets/login_bg/Autumn - Vermonter.jpg", "assets/login_bg/Spring - California Zephyr.jpg", "assets/login_bg/Spring - Cardinal.jpg", "assets/login_bg/Spring - Lake Shore Limited.jpg", "assets/login_bg/Spring - Pennsylvanian.jpg", "assets/login_bg/Summer - Amtrak Cascades.jpg", "assets/login_bg/Summer - Capital Limited.jpg", "assets/login_bg/Summer - Empire Service.jpg", "assets/login_bg/Summer - Pacific Surfliner.jpg", "assets/login_bg/Winter - Acela.jpg", "assets/login_bg/Winter - Downeaster.jpg", "assets/login_bg/Winter - Northeast Regional.jpg", "assets/login_bg/Winter - Winter Park Express.jpg"];

function startBgCycle(){
  const a = document.getElementById("bgA");
  const b = document.getElementById("bgB");
  if(!a || !b || !LOGIN_BACKGROUNDS.length) return;

  LOGIN_BACKGROUNDS.forEach(u=>{ const i=new Image(); i.src=u; });

  let idx = 0;
  let showA = true;

  a.style.backgroundImage = `url("${LOGIN_BACKGROUNDS[0]}")`;
  a.style.opacity = "1";
  b.style.opacity = "0";

  setInterval(()=>{
    idx = (idx + 1) % LOGIN_BACKGROUNDS.length;
    const next = LOGIN_BACKGROUNDS[idx];
    if(showA){
      b.style.backgroundImage = `url("${next}")`;
      b.style.opacity = "1";
      a.style.opacity = "0";
    } else {
      a.style.backgroundImage = `url("${next}")`;
      a.style.opacity = "1";
      b.style.opacity = "0";
    }
    showA = !showA;
  }, 11500); // 10s pause + 1.5s fade
}

// --- Auth login handler ---
async function doLogin(username, password){
  const errEl = document.getElementById("err");
  if(errEl) errEl.textContent = "";
  try{
    const res = await fetch("/api/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      cache: "no-store",
    });
    const data = await res.json().catch(()=>null);
    if(!res.ok){
      if(errEl) errEl.textContent = (data && (data.detail ? (data.error + ": " + data.detail) : data.error)) ? (data.detail ? (data.error + ": " + data.detail) : data.error) : "Login failed";
      return;
    }
    location.href = "/";
  } catch(e) {
    if(errEl) errEl.textContent = "Network error";
  }
}

function wireLogin(){
  const form = document.getElementById("loginForm");
  const btn = document.getElementById("submitBtn");
  const user = document.getElementById("username");
  const pass = document.getElementById("password");

  async function handler(ev){
    if(ev) ev.preventDefault();
    const u = (user && user.value) ? user.value.trim() : "";
    const p = (pass && pass.value) ? pass.value : "";
    if(!u || !p) return;
    await doLogin(u, p);
  }

  if(form) form.addEventListener("submit", handler);
  if(btn) btn.addEventListener("click", handler);
}

document.addEventListener("DOMContentLoaded", ()=>{
  startBgCycle();
  wireLogin();
});
// Extra diagnostics (safe to keep)
window.debugLogin = async function(){
  const u = document.getElementById("username")?.value || "";
  const p = document.getElementById("password")?.value || "";
  try{
    const r = await fetch("/api/auth/login", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({username:u, password:p})});
    const t = await r.text();
    console.log("LOGIN RESP", r.status, t);
    return {status:r.status, body:t};
  }catch(e){
    console.log("LOGIN ERR", e);
    return {error:String(e)};
  }
};
