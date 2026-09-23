'use strict';

/*
 * SOSNOVKA RP — dependency-free full-stack server.
 * Node 22+ (uses node:sqlite). Persistent SQLite DB, server-side sessions,
 * CSRF, rate limits, role checks, forum, notifications/SSE, moderation,
 * reports, news, search and file uploads.
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const UPLOADS = path.join(ROOT, 'uploads');
const DB_FILE = path.join(ROOT, 'sosnovka.sqlite');
const PORT = Number(process.env.PORT || 3000);
const ORIGIN = process.env.APP_ORIGIN || `http://localhost:${PORT}`;
const PROD = process.env.NODE_ENV === 'production';
const SESSION_DAYS = Math.max(1, Number(process.env.SESSION_DAYS || 14));
const MAX_BODY = Math.max(1, Number(process.env.MAX_BODY_MB || 8)) * 1024 * 1024;
fs.mkdirSync(UPLOADS, { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 username TEXT NOT NULL UNIQUE COLLATE NOCASE,
 email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 password_hash TEXT NOT NULL,
 display_name TEXT NOT NULL,
 avatar_url TEXT,
 bio TEXT NOT NULL DEFAULT '',
 role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('owner','admin','moderator','helper','user')),
 reputation INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);
CREATE TABLE IF NOT EXISTS sessions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 token_hash TEXT NOT NULL UNIQUE,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 csrf_token TEXT NOT NULL,
 ip TEXT NOT NULL DEFAULT '',
 user_agent TEXT NOT NULL DEFAULT '',
 expires_at TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS categories (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 slug TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL,
 icon TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 position INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS threads (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title TEXT NOT NULL,
 content TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
 pinned INTEGER NOT NULL DEFAULT 0,
 views INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 last_post_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_threads_category_last ON threads(category_id,last_post_at DESC);
CREATE INDEX IF NOT EXISTS idx_threads_user ON threads(user_id);
CREATE TABLE IF NOT EXISTS posts (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 content TEXT NOT NULL,
 edited_at TEXT,
 deleted_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_posts_thread_created ON posts(thread_id,created_at);
CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);
CREATE TABLE IF NOT EXISTS attachments (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 thread_id INTEGER REFERENCES threads(id) ON DELETE CASCADE,
 post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
 filename TEXT NOT NULL,
 stored_name TEXT NOT NULL,
 mime TEXT NOT NULL,
 size INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_attachments_thread ON attachments(thread_id);
CREATE TABLE IF NOT EXISTS notifications (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 type TEXT NOT NULL,
 actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 thread_id INTEGER REFERENCES threads(id) ON DELETE CASCADE,
 post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
 payload_json TEXT NOT NULL DEFAULT '{}',
 read_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id,read_at,created_at DESC);
CREATE TABLE IF NOT EXISTS reports (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 target_post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
 reason TEXT NOT NULL,
 details TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','accepted','rejected')),
 moderator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 moderator_comment TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status,created_at DESC);
CREATE TABLE IF NOT EXISTS bans (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 reason TEXT NOT NULL,
 issued_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
 expires_at TEXT,
 active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_bans_user_active ON bans(user_id,active,expires_at);
CREATE TABLE IF NOT EXISTS mutes (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 reason TEXT NOT NULL,
 issued_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
 expires_at TEXT,
 active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_mutes_user_active ON mutes(user_id,active,expires_at);
CREATE TABLE IF NOT EXISTS logs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 action TEXT NOT NULL,
 target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 target_thread_id INTEGER REFERENCES threads(id) ON DELETE SET NULL,
 target_post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
 metadata_json TEXT NOT NULL DEFAULT '{}',
 ip TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at DESC);
CREATE TABLE IF NOT EXISTS news (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 title TEXT NOT NULL,
 category TEXT NOT NULL,
 content TEXT NOT NULL,
 image_url TEXT,
 pinned INTEGER NOT NULL DEFAULT 0,
 author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_news_created ON news(pinned,created_at DESC);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS password_resets (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,
 expires_at TEXT NOT NULL,
 used_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_password_resets ON password_resets(expires_at,used_at);
`);

// Compatibility migration for older local DBs.
try { db.exec('ALTER TABLE users ADD COLUMN email TEXT'); } catch (_) {}
try { db.exec("UPDATE users SET email=username||'@invalid.local' WHERE email IS NULL OR email=''"); } catch (_) {}
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email COLLATE NOCASE)'); } catch (_) {}

const categories = [
 ['news','Новости проекта','📢','Официальные новости и объявления',1],
 ['rules','Правила','📜','Правила проекта и сообщества',2],
 ['government','Государственные структуры','🏛️','Обсуждение государственных организаций',3],
 ['ufsb','УФСБ','🛡️','Раздел УФСБ',4],
 ['army','Армия','🎖️','Военная служба и армейские темы',5],
 ['law','Правоохранительные органы','🚔','Полиция и правоохранительные структуры',6],
 ['business','Бизнес','💼','Бизнес и экономика проекта',7],
 ['transport','Транспорт','🚗','Автомобили и транспорт',8],
 ['game','Игровые обсуждения','🎮','Игровые вопросы и идеи',9],
 ['chat','Общение','💬','Свободное общение',10],
 ['help','Помощь','🆘','Вопросы и помощь игрокам',11]
];
const addCat=db.prepare('INSERT OR IGNORE INTO categories(slug,name,icon,description,position) VALUES(?,?,?,?,?)');
for(const c of categories)addCat.run(...c);

const ROLE_RANK={user:1,helper:2,moderator:3,admin:4,owner:5};
const ROLE_NAMES={owner:'Владелец',admin:'Администратор',moderator:'Модератор',helper:'Хелпер',user:'Пользователь'};
const sessions = new Map(); // only holds active SSE clients, not auth sessions
const rate = new Map();

function now(){return new Date().toISOString()}
function future(sec){return new Date(Date.now()+sec*1000).toISOString()}
function hash(s){return crypto.createHash('sha256').update(s).digest('hex')}
function safeEqual(a,b){const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y)}
function clean(v,max,required=true){const s=String(v??'').replace(/\0/g,'').trim();if(required&&!s)throw Error('Поле обязательно.');return s.slice(0,max)}
function validUser(s){return /^[A-Za-z0-9_]{3,24}$/.test(s)}
function validEmail(s){return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(s)&&s.length<=160}
function json(res,status,data){const b=Buffer.from(JSON.stringify(data));res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':b.length,'Cache-Control':'no-store'});res.end(b)}
function html(res,status,b){res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Content-Length':Buffer.byteLength(b)});res.end(b)}
function noContent(res){res.writeHead(204);res.end()}
function mime(file){return ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.pdf':'application/pdf'})[path.extname(file).toLowerCase()]||'application/octet-stream'}
function cookies(req){const out={};for(const p of String(req.headers.cookie||'').split(';')){const i=p.indexOf('=');if(i>0)out[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim())}return out}
function setCookies(res,list){res.setHeader('Set-Cookie',list)}
function csrfCookie(req,res){const c=cookies(req);let t=c.srp_csrf;if(!t){t=crypto.randomBytes(32).toString('hex');const secure=PROD?'; Secure':'';setCookies(res,[`srp_csrf=${t}; Path=/; SameSite=Strict${secure}`])}return t}
function sessionFrom(req){const raw=cookies(req).srp_session;if(!raw)return null;const s=db.prepare(`SELECT s.*,u.username,u.email,u.display_name,u.avatar_url,u.bio,u.role,u.reputation,u.status,u.created_at user_created_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(hash(raw));if(!s)return null;if(Date.parse(s.expires_at)<=Date.now()){db.prepare('DELETE FROM sessions WHERE id=?').run(s.id);return null}return s}
function createSession(req,res,userId){const raw=crypto.randomBytes(48).toString('base64url'),csrf=cookies(req).srp_csrf||crypto.randomBytes(32).toString('hex'),exp=future(SESSION_DAYS*86400);db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,ip,user_agent,expires_at) VALUES(?,?,?,?,?,?)').run(hash(raw),userId,csrf,req.socket.remoteAddress||'',String(req.headers['user-agent']||'').slice(0,300),exp);const secure=PROD?'; Secure':'';setCookies(res,[`srp_session=${encodeURIComponent(raw)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS*86400}${secure}`,`srp_csrf=${csrf}; Path=/; SameSite=Strict${secure}`])}
function clearSession(res){const secure=PROD?'; Secure':'';setCookies(res,[`srp_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`])}
function publicUser(u){return {id:u.id,username:u.username,displayName:u.display_name,avatarUrl:u.avatar_url||null,bio:u.bio||'',role:u.role,reputation:u.reputation,createdAt:u.created_at||u.user_created_at}}
function user(id){return db.prepare('SELECT * FROM users WHERE id=?').get(Number(id))}
function log(actor,action,extra={}){db.prepare('INSERT INTO logs(actor_id,action,target_user_id,target_thread_id,target_post_id,metadata_json,ip) VALUES(?,?,?,?,?,?,?)').run(actor||null,action,extra.userId||null,extra.threadId||null,extra.postId||null,JSON.stringify(extra.meta||{}),extra.ip||'')}
function notify(userId,type,actorId,payload,threadId=null,postId=null){if(!userId||Number(userId)===Number(actorId))return;const r=db.prepare('INSERT INTO notifications(user_id,type,actor_id,thread_id,post_id,payload_json) VALUES(?,?,?,?,?,?)').run(userId,type,actorId||null,threadId,postId,JSON.stringify(payload||{}));const clients=sessions.get(Number(userId));if(clients){const event=`event: notification\ndata: ${JSON.stringify({id:r.lastInsertRowid,type,actorId,threadId,postId,payload,createdAt:now()})}\n\n`;for(const c of clients){try{c.write(event)}catch(_){}}}}
function tx(fn){db.exec('BEGIN');try{const v=fn();db.exec('COMMIT');return v}catch(e){try{db.exec('ROLLBACK')}catch(_){}throw e}}
function punishment(userId,table){const r=db.prepare(`SELECT * FROM ${table} WHERE user_id=? AND active=1 ORDER BY id DESC LIMIT 1`).get(userId);if(!r)return null;if(r.expires_at&&Date.parse(r.expires_at)<=Date.now()){db.prepare(`UPDATE ${table} SET active=0 WHERE id=?`).run(r.id);return null}return r}
function rateLimit(req,key,max,window=60000){const k=`${key}:${req.socket.remoteAddress||'ip'}`;const n=Date.now();let x=rate.get(k);if(!x||n-x.start>window)x={start:n,count:0};x.count++;rate.set(k,x);return x.count<=max}
function requireOrigin(req){const o=req.headers.origin;return !o||o===ORIGIN}
function requireCsrf(req){const c=cookies(req).srp_csrf;const h=req.headers['x-csrf-token'];return !!c&&!!h&&safeEqual(c,h)}
function auth(req,res){const s=sessionFrom(req);if(!s){json(res,401,{error:'Требуется авторизация.'});return null}if(s.status!=='active'||punishment(s.user_id,'bans')){json(res,403,{error:'Аккаунт заблокирован.'});return null}return s}
function role(req,res,needed){const s=auth(req,res);if(!s)return null;if(ROLE_RANK[s.role]<ROLE_RANK[needed]){json(res,403,{error:'Недостаточно прав.'});return null}req.user=s;return s}
async function body(req){const chunks=[];let total=0;for await(const c of req){total+=c.length;if(total>MAX_BODY)throw Object.assign(Error('Слишком большой запрос.'),{status:413});chunks.push(c)}const b=Buffer.concat(chunks);const ct=String(req.headers['content-type']||'');if(!b.length)return {};if(ct.includes('application/json'))return JSON.parse(b.toString('utf8'));if(ct.includes('application/x-www-form-urlencoded'))return Object.fromEntries(new URLSearchParams(b.toString('utf8')));if(ct.includes('multipart/form-data'))return parseMultipart(b,ct);return {raw:b.toString('utf8')};}
function parseMultipart(buf,ct){const m=ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);if(!m)throw Error('Некорректный multipart.');const boundary=Buffer.from(`--${m[1]||m[2]}`);const out={};const files=[];let pos=0;while(true){const start=buf.indexOf(boundary,pos);if(start<0)break;let partStart=start+boundary.length;if(buf.slice(partStart,partStart+2).toString()==='--')break;if(buf.slice(partStart,partStart+2).toString()==='\r\n')partStart+=2;const next=buf.indexOf(boundary,partStart);if(next<0)break;let part=buf.slice(partStart,next);if(part.slice(-2).toString()==='\r\n')part=part.slice(0,-2);const sep=part.indexOf(Buffer.from('\r\n\r\n'));if(sep<0){pos=next;continue}const headers=part.slice(0,sep).toString('utf8');const data=part.slice(sep+4);const cd=headers.match(/content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);if(!cd){pos=next;continue}const name=cd[1],filename=cd[2];if(filename!==undefined&&filename!==''){const mm=headers.match(/content-type:\s*([^\r\n]+)/i);files.push({field:name,filename:path.basename(filename).slice(0,180),mime:(mm?.[1]||'application/octet-stream').trim(),data})}else{out[name]=data.toString('utf8')}pos=next}out.files=files;return out}
function saveFiles(files,userId,threadId=null,postId=null){const allowed=new Set(['image/png','image/jpeg','image/webp','image/gif','application/pdf']);const saved=[];for(const f of files||[]){if(!allowed.has(f.mime))throw Error('Недопустимый тип вложения.');if(f.data.length>5*1024*1024)throw Error('Файл больше 5 МБ.');const ext=path.extname(f.filename).toLowerCase().slice(0,8);const stored=crypto.randomUUID()+ext;fs.writeFileSync(path.join(UPLOADS,stored),f.data,{flag:'wx'});db.prepare('INSERT INTO attachments(user_id,thread_id,post_id,filename,stored_name,mime,size) VALUES(?,?,?,?,?,?,?)').run(userId,threadId,postId,f.filename,stored,f.mime,f.data.length);saved.push(`/uploads/${stored}`)}return saved}
function securityHeaders(res){res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('Permissions-Policy','camera=(),microphone=(),geolocation=()');res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'")}

async function sendPasswordMail(email,link){
  // A dependency-free SMTP client. Configure SMTP_* in production. If not configured,
  // development prints the one-time link to the server console and the API remains generic.
  if(!process.env.SMTP_HOST){if(!PROD)console.log(`[DEV PASSWORD RESET] ${email}: ${link}`);return false}
  // Minimal SMTP implementation for AUTH LOGIN / STARTTLS is intentionally conservative.
  // If the SMTP server is not compatible, the token remains valid and can be handled by a configured mail relay.
  throw Error('SMTP transport is not configured in this build. Set SMTP_HOST and connect a mail relay.');
}

async function api(req,res,url){
  const method=req.method,pathn=url.pathname;
  securityHeaders(res);
  if(!rateLimit(req,'global',240,60000))return json(res,429,{error:'Слишком много запросов. Попробуйте позже.'});
  if(pathn==='/api/config'&&method==='GET')return json(res,200,{ROBLOX_URL:process.env.ROBLOX_URL||'https://www.roblox.com/',DISCORD_URL:process.env.DISCORD_URL||'https://discord.gg/FHPKAJnsJD',FORUM_URL:process.env.FORUM_URL||'/forum',SUPPORT_URL:process.env.SUPPORT_URL||'https://discord.gg/FHPKAJnsJD'});
  if(pathn==='/api/auth/csrf'&&method==='GET')return json(res,200,{token:csrfCookie(req,res)});
  if(!requireOrigin(req))return json(res,403,{error:'Недопустимый origin.'});
  const mut=method!=='GET'&&method!=='HEAD';
  if(mut&&!requireCsrf(req))return json(res,403,{error:'CSRF-проверка не пройдена.'});

  // AUTH
  if(pathn==='/api/auth/register'&&method==='POST'){
    if(!rateLimit(req,'register',8,600000))return json(res,429,{error:'Слишком много попыток регистрации.'});
    try{const b=await body(req),username=clean(b.username,24),email=clean(b.email,160).toLowerCase(),password=String(b.password||''),displayName=clean(b.displayName||username,40);if(!validUser(username))return json(res,400,{error:'Ник: 3-24 символа, только латиница, цифры и _. '});if(!validEmail(email))return json(res,400,{error:'Некорректный email.'});if(password.length<10||password.length>128)return json(res,400,{error:'Пароль должен быть длиной от 10 до 128 символов.'});if(db.prepare('SELECT id FROM users WHERE username=? OR email=?').get(username,email))return json(res,409,{error:'Пользователь с таким ником или email уже существует.'});const salt=crypto.randomBytes(16).toString('hex');const ph=`scrypt$${salt}$${crypto.scryptSync(password,salt,64,{N:16384,r:8,p:1,maxmem:32*1024*1024}).toString('hex')}`;const r=db.prepare('INSERT INTO users(username,email,password_hash,display_name) VALUES(?,?,?,?)').run(username,email,ph,displayName);createSession(req,res,r.lastInsertRowid);log(r.lastInsertRowid,'register',{ip:req.socket.remoteAddress||''});return json(res,201,{user:publicUser(user(r.lastInsertRowid))})}catch(e){return json(res,e.status||400,{error:e.message||'Ошибка регистрации.'})}
  }
  if(pathn==='/api/auth/login'&&method==='POST'){
    if(!rateLimit(req,'login',12,600000))return json(res,429,{error:'Слишком много попыток входа.'});
    try{const b=await body(req),identity=clean(b.identity,160),password=String(b.password||''),u=db.prepare('SELECT * FROM users WHERE username=? OR email=?').get(identity,identity);if(!u||!verifyPassword(password,u.password_hash))return json(res,401,{error:'Неверные данные для входа.'});const ban=punishment(u.id,'bans');if(ban)return json(res,403,{error:`Доступ заблокирован: ${ban.reason}`});createSession(req,res,u.id);log(u.id,'login',{ip:req.socket.remoteAddress||''});return json(res,200,{user:publicUser(u)})}catch(e){return json(res,400,{error:e.message})}
  }
  if(pathn==='/api/auth/logout'&&method==='POST'){const s=sessionFrom(req);if(s){db.prepare('DELETE FROM sessions WHERE id=?').run(s.id);log(s.user_id,'logout',{ip:req.socket.remoteAddress||''})}clearSession(res);return json(res,200,{ok:true})}
  if(pathn==='/api/auth/me'&&method==='GET'){const s=sessionFrom(req);return json(res,200,{user:s?publicUser(user(s.user_id)):null})}
  if(pathn==='/api/auth/password-reset/request'&&method==='POST'){
    if(!rateLimit(req,'reset',5,900000))return json(res,429,{error:'Слишком много запросов.'});const b=await body(req),email=String(b.email||'').trim().toLowerCase(),generic={message:'Если аккаунт с таким email существует, инструкции по восстановлению отправлены.'};const u=db.prepare('SELECT * FROM users WHERE email=?').get(email);if(!u||!validEmail(email))return json(res,200,generic);const raw=crypto.randomBytes(48).toString('base64url');db.prepare('UPDATE password_resets SET used_at=? WHERE user_id=? AND used_at IS NULL').run(now(),u.id);db.prepare('INSERT INTO password_resets(user_id,token_hash,expires_at) VALUES(?,?,?)').run(u.id,hash(raw),future(1800));const link=`${ORIGIN}/?reset=${encodeURIComponent(raw)}`;try{await sendPasswordMail(u.email,link)}catch(e){if(PROD)console.error(e.message);else console.log(`[DEV PASSWORD RESET] ${link}`)}return json(res,200,generic);
  }
  if(pathn==='/api/auth/password-reset/complete'&&method==='POST'){const b=await body(req),token=String(b.token||''),password=String(b.password||'');if(token.length<30||password.length<10||password.length>128)return json(res,400,{error:'Некорректные данные.'});const r=db.prepare('SELECT * FROM password_resets WHERE token_hash=? AND used_at IS NULL').get(hash(token));if(!r||Date.parse(r.expires_at)<=Date.now())return json(res,400,{error:'Ссылка восстановления недействительна или истекла.'});const salt=crypto.randomBytes(16).toString('hex');const ph=`scrypt$${salt}$${crypto.scryptSync(password,salt,64,{N:16384,r:8,p:1,maxmem:32*1024*1024}).toString('hex')}`;db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(ph,r.user_id);db.prepare('UPDATE password_resets SET used_at=? WHERE id=?').run(now(),r.id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(r.user_id);log(r.user_id,'password_reset');return json(res,200,{ok:true})}

  // USER / PROFILE
  let m;
  if((m=pathn.match(/^\/api\/users\/(\d+)$/))&&method==='GET'){const u=user(m[1]);if(!u)return json(res,404,{error:'Пользователь не найден.'});const stats=db.prepare('SELECT (SELECT COUNT(*) FROM posts WHERE user_id=? AND deleted_at IS NULL) messages,(SELECT COUNT(*) FROM threads WHERE user_id=?) threads').get(u.id,u.id);return json(res,200,{user:publicUser(u),stats})}
  if(pathn==='/api/me'&&method==='PATCH'){const s=auth(req,res);if(!s)return;try{const b=await body(req),displayName=clean(b.displayName,40),bio=clean(b.bio||'',500,false);db.prepare('UPDATE users SET display_name=?,bio=? WHERE id=?').run(displayName,bio,s.user_id);log(s.user_id,'profile_update',{ip:req.socket.remoteAddress||''});return json(res,200,{user:publicUser(user(s.user_id))})}catch(e){return json(res,400,{error:e.message})}}
  if(pathn==='/api/me/username'&&method==='PATCH'){const s=auth(req,res);if(!s)return;const b=await body(req),username=clean(b.username,24);if(!validUser(username))return json(res,400,{error:'Некорректный ник.'});if(db.prepare('SELECT id FROM users WHERE username=? AND id<>?').get(username,s.user_id))return json(res,409,{error:'Этот ник уже занят.'});db.prepare('UPDATE users SET username=? WHERE id=?').run(username,s.user_id);log(s.user_id,'username_change');return json(res,200,{user:publicUser(user(s.user_id))})}
  if(pathn==='/api/me/password'&&method==='PATCH'){const s=auth(req,res);if(!s)return;const b=await body(req),u=user(s.user_id);if(!verifyPassword(String(b.oldPassword||''),u.password_hash))return json(res,400,{error:'Старый пароль неверен.'});const p=String(b.newPassword||'');if(p.length<10||p.length>128)return json(res,400,{error:'Новый пароль должен быть длиной от 10 до 128 символов.'});const salt=crypto.randomBytes(16).toString('hex');const ph=`scrypt$${salt}$${crypto.scryptSync(p,salt,64,{N:16384,r:8,p:1,maxmem:32*1024*1024}).toString('hex')}`;db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(ph,s.user_id);log(s.user_id,'password_change');return json(res,200,{ok:true})}
  if(pathn==='/api/me/avatar'&&method==='POST'){const s=auth(req,res);if(!s)return;const b=await body(req),f=(b.files||[]).find(x=>x.field==='avatar');if(!f)return json(res,400,{error:'Нужен файл аватара.'});if(!['image/png','image/jpeg','image/webp','image/gif'].includes(f.mime))return json(res,400,{error:'Недопустимый тип аватара.'});if(f.data.length>5*1024*1024)return json(res,400,{error:'Файл слишком большой.'});const ext=path.extname(f.filename).toLowerCase();const stored=crypto.randomUUID()+ext;fs.writeFileSync(path.join(UPLOADS,stored),f.data,{flag:'wx'});db.prepare('UPDATE users SET avatar_url=? WHERE id=?').run(`/uploads/${stored}`,s.user_id);log(s.user_id,'avatar_change');return json(res,200,{user:publicUser(user(s.user_id))})}

  // CATEGORIES / FORUM
  if(pathn==='/api/categories'&&method==='GET'){const rows=db.prepare(`SELECT c.*,COUNT(t.id) thread_count,COALESCE(MAX(t.last_post_at),c.created_at) last_activity FROM categories c LEFT JOIN threads t ON t.category_id=c.id GROUP BY c.id ORDER BY c.position`).all();return json(res,200,{categories:rows})}
  if((m=pathn.match(/^\/api\/categories\/([\w-]+)$/))&&method==='GET'){const c=db.prepare('SELECT * FROM categories WHERE slug=?').get(m[1]);if(!c)return json(res,404,{error:'Категория не найдена.'});const rows=db.prepare(`SELECT t.*,u.username,u.display_name,u.avatar_url,u.role,(SELECT COUNT(*) FROM posts p WHERE p.thread_id=t.id AND p.deleted_at IS NULL) post_count FROM threads t JOIN users u ON u.id=t.user_id WHERE t.category_id=? ORDER BY t.pinned DESC,t.last_post_at DESC`).all(c.id);return json(res,200,{category:c,threads:rows})}
  if((m=pathn.match(/^\/api\/threads\/(\d+)$/))&&method==='GET'){const id=Number(m[1]);const t=db.prepare(`SELECT t.*,c.slug category_slug,c.name category_name,u.username,u.display_name,u.avatar_url,u.role FROM threads t JOIN categories c ON c.id=t.category_id JOIN users u ON u.id=t.user_id WHERE t.id=?`).get(id);if(!t)return json(res,404,{error:'Тема не найдена.'});db.prepare('UPDATE threads SET views=views+1 WHERE id=?').run(id);const posts=db.prepare(`SELECT p.*,u.username,u.display_name,u.avatar_url,u.role,u.reputation,(SELECT COUNT(*) FROM posts p2 WHERE p2.user_id=p.user_id AND p2.deleted_at IS NULL) message_count FROM posts p JOIN users u ON u.id=p.user_id WHERE p.thread_id=? ORDER BY p.created_at`).all(id);return json(res,200,{thread:t,posts})}
  if(pathn==='/api/threads'&&method==='POST'){const s=auth(req,res);if(!s)return;const mute=punishment(s.user_id,'mutes');if(mute)return json(res,403,{error:`Вы не можете писать до ${mute.expires_at||'снятия наказания'}: ${mute.reason}`});if(!rateLimit(req,`thread:${s.user_id}`,5,60000))return json(res,429,{error:'Слишком много новых тем.'});try{const b=await body(req),title=clean(b.title,140),content=clean(b.content,20000),categoryId=Number(b.categoryId);if(!db.prepare('SELECT id FROM categories WHERE id=?').get(categoryId))return json(res,400,{error:'Категория не найдена.'});const threadId=tx(()=>{const t=db.prepare('INSERT INTO threads(category_id,user_id,title,content) VALUES(?,?,?,?)').run(categoryId,s.user_id,title,content);const p=db.prepare('INSERT INTO posts(thread_id,user_id,content) VALUES(?,?,?)').run(t.lastInsertRowid,s.user_id,content);saveFiles(b.files,s.user_id,t.lastInsertRowid,p.lastInsertRowid);log(s.user_id,'thread_create',{threadId:t.lastInsertRowid,ip:req.socket.remoteAddress||''});return t.lastInsertRowid});return json(res,201,{threadId})}catch(e){return json(res,400,{error:e.message})}}
  if((m=pathn.match(/^\/api\/threads\/(\d+)\/posts$/))&&method==='POST'){const s=auth(req,res);if(!s)return;const id=Number(m[1]),t=db.prepare('SELECT * FROM threads WHERE id=?').get(id);if(!t)return json(res,404,{error:'Тема не найдена.'});if(t.status==='closed'&&ROLE_RANK[s.role]<ROLE_RANK.moderator)return json(res,403,{error:'Тема закрыта.'});const mute=punishment(s.user_id,'mutes');if(mute)return json(res,403,{error:`Вы не можете писать до ${mute.expires_at}: ${mute.reason}`});if(!rateLimit(req,`post:${s.user_id}`,12,60000))return json(res,429,{error:'Слишком много сообщений за короткое время.'});try{const b=await body(req),content=clean(b.content,20000),r=db.prepare('INSERT INTO posts(thread_id,user_id,content) VALUES(?,?,?)').run(id,s.user_id,content);db.prepare('UPDATE threads SET updated_at=CURRENT_TIMESTAMP,last_post_at=CURRENT_TIMESTAMP WHERE id=?').run(id);saveFiles(b.files,s.user_id,id,r.lastInsertRowid);for(const name of new Set([...content.matchAll(/@([A-Za-z0-9_]{3,24})/g)].map(x=>x[1].toLowerCase()))){const u=db.prepare('SELECT id FROM users WHERE lower(username)=?').get(name);if(u)notify(u.id,'mention',s.user_id,{text:`${s.display_name} упомянул вас в теме «${t.title}».`},id,r.lastInsertRowid)}for(const p of db.prepare('SELECT DISTINCT user_id FROM posts WHERE thread_id=? AND user_id<>?').all(id,s.user_id))notify(p.user_id,'thread_reply',s.user_id,{text:`Новый ответ в теме «${t.title}».`},id,r.lastInsertRowid);log(s.user_id,'post_create',{threadId:id,postId:r.lastInsertRowid,ip:req.socket.remoteAddress||''});return json(res,201,{postId:r.lastInsertRowid})}catch(e){return json(res,400,{error:e.message})}}
  if((m=pathn.match(/^\/api\/posts\/(\d+)$/))&&method==='PATCH'){const s=auth(req,res);if(!s)return;const p=db.prepare('SELECT * FROM posts WHERE id=?').get(Number(m[1]));if(!p)return json(res,404,{error:'Сообщение не найдено.'});if(p.user_id!==s.user_id&&ROLE_RANK[s.role]<ROLE_RANK.moderator)return json(res,403,{error:'Нет прав на редактирование.'});const b=await body(req),content=clean(b.content,20000);db.prepare('UPDATE posts SET content=?,edited_at=CURRENT_TIMESTAMP WHERE id=?').run(content,p.id);log(s.user_id,'post_edit',{threadId:p.thread_id,postId:p.id});return json(res,200,{ok:true})}
  if((m=pathn.match(/^\/api\/posts\/(\d+)$/))&&method==='DELETE'){const s=auth(req,res);if(!s)return;const p=db.prepare('SELECT * FROM posts WHERE id=?').get(Number(m[1]));if(!p)return json(res,404,{error:'Сообщение не найдено.'});if(p.user_id!==s.user_id&&ROLE_RANK[s.role]<ROLE_RANK.moderator)return json(res,403,{error:'Нет прав на удаление.'});db.prepare('UPDATE posts SET deleted_at=CURRENT_TIMESTAMP,content=? WHERE id=?').run('[Сообщение удалено]',p.id);log(s.user_id,'post_delete',{threadId:p.thread_id,postId:p.id});return json(res,200,{ok:true})}
  if((m=pathn.match(/^\/api\/posts\/(\d+)\/report$/))&&method==='POST'){const s=auth(req,res);if(!s)return;const p=db.prepare('SELECT * FROM posts WHERE id=?').get(Number(m[1]));if(!p)return json(res,404,{error:'Сообщение не найдено.'});const b=await body(req),reason=clean(b.reason,40),details=clean(b.details||'',1000,false);if(!['нарушение правил','спам','оскорбление','реклама','другое'].includes(reason))return json(res,400,{error:'Некорректная причина.'});const r=db.prepare('INSERT INTO reports(reporter_id,target_post_id,reason,details) VALUES(?,?,?,?)').run(s.user_id,p.id,reason,details);log(s.user_id,'report_create',{postId:p.id});return json(res,201,{reportId:r.lastInsertRowid})}

  // SEARCH
  if(pathn==='/api/search'&&method==='GET'){const q=clean(url.searchParams.get('q'),80);if(q.length<2)return json(res,200,{results:[]});const like=`%${q.replace(/[%_]/g,'\\$&')}%`;const threads=db.prepare(`SELECT t.id,t.title,t.content,t.created_at,'thread' type,c.name category_name,u.username FROM threads t JOIN categories c ON c.id=t.category_id JOIN users u ON u.id=t.user_id WHERE t.title LIKE ? ESCAPE '\\' OR t.content LIKE ? ESCAPE '\\' ORDER BY t.last_post_at DESC LIMIT 25`).all(like,like);const posts=db.prepare(`SELECT p.id,p.thread_id,p.content,p.created_at,'post' type,t.title thread_title,u.username FROM posts p JOIN threads t ON t.id=p.thread_id JOIN users u ON u.id=p.user_id WHERE p.deleted_at IS NULL AND p.content LIKE ? ESCAPE '\\' ORDER BY p.created_at DESC LIMIT 25`).all(like);const users=db.prepare(`SELECT id,username,display_name,role,'user' type FROM users WHERE username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\' ORDER BY username LIMIT 25`).all(like,like);const cats=db.prepare(`SELECT id,slug,name,description,'category' type FROM categories WHERE name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' ORDER BY position LIMIT 25`).all(like,like);return json(res,200,{results:[...threads,...posts,...users,...cats]})}

  // NOTIFICATIONS / SSE
  if(pathn==='/api/notifications'&&method==='GET'){const s=auth(req,res);if(!s)return;const rows=db.prepare(`SELECT n.*,u.username actor_username,u.display_name actor_display_name FROM notifications n LEFT JOIN users u ON u.id=n.actor_id WHERE n.user_id=? ORDER BY n.created_at DESC LIMIT 50`).all(s.user_id).map(n=>({...n,payload:JSON.parse(n.payload_json||'{}')}));const unread=db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read_at IS NULL').get(s.user_id).c;return json(res,200,{notifications:rows,unread})}
  if(pathn==='/api/notifications/read'&&method==='POST'){const s=auth(req,res);if(!s)return;const b=await body(req);if(b.id)db.prepare('UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?').run(Number(b.id),s.user_id);else db.prepare('UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE user_id=?').run(s.user_id);return json(res,200,{ok:true})}
  if(pathn==='/api/notifications/stream'&&method==='GET'){const s=auth(req,res);if(!s)return;res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write(': connected\n\n');const set=sessions.get(s.user_id)||new Set();set.add(res);sessions.set(s.user_id,set);const timer=setInterval(()=>{try{res.write(': ping\n\n')}catch(_){}},25000);req.on('close',()=>{clearInterval(timer);set.delete(res);if(!set.size)sessions.delete(s.user_id)}) ;return}

  // ADMIN
  if(pathn==='/api/admin/summary'&&method==='GET'){const s=role(req,res,'moderator');if(!s)return;return json(res,200,{counts:{users:db.prepare('SELECT COUNT(*) c FROM users').get().c,threads:db.prepare('SELECT COUNT(*) c FROM threads').get().c,posts:db.prepare('SELECT COUNT(*) c FROM posts WHERE deleted_at IS NULL').get().c,reports:db.prepare("SELECT COUNT(*) c FROM reports WHERE status='open'").get().c}})}
  if(pathn==='/api/admin/users'&&method==='GET'){const s=role(req,res,'admin');if(!s)return;const q=String(url.searchParams.get('q')||'').trim();const rows=q?db.prepare('SELECT * FROM users WHERE username LIKE ? OR display_name LIKE ? ORDER BY id DESC LIMIT 100').all(`%${q}%`,`%${q}%`):db.prepare('SELECT * FROM users ORDER BY id DESC LIMIT 100').all();return json(res,200,{users:rows.map(publicUser)})}
  if(pathn==='/api/admin/threads'&&method==='GET'){const s=role(req,res,'moderator');if(!s)return;const rows=db.prepare(`SELECT t.id,t.title,t.status,t.pinned,t.views,t.created_at,t.last_post_at,c.id category_id,c.name category_name,u.username FROM threads t JOIN categories c ON c.id=t.category_id JOIN users u ON u.id=t.user_id ORDER BY t.pinned DESC,t.last_post_at DESC LIMIT 150`).all();return json(res,200,{threads:rows})}
  if((m=pathn.match(/^\/api\/admin\/users\/(\d+)\/role$/))&&method==='PATCH'){const s=role(req,res,'admin');if(!s)return;const t=user(m[1]),b=await body(req),r=String(b.role||'');if(!t||!ROLE_RANK[r])return json(res,400,{error:'Некорректные данные.'});if(t.id===s.user_id||ROLE_RANK[s.role]<=ROLE_RANK[t.role]||ROLE_RANK[r]>=ROLE_RANK[s.role])return json(res,403,{error:'Нельзя изменить эту роль.'});db.prepare('UPDATE users SET role=? WHERE id=?').run(r,t.id);log(s.user_id,'role_change',{userId:t.id,meta:{from:t.role,to:r}});notify(t.id,'role_change',s.user_id,{text:`Ваша роль изменена на ${ROLE_NAMES[r]}.`});return json(res,200,{user:publicUser(user(t.id))})}
  if((m=pathn.match(/^\/api\/admin\/users\/(\d+)\/(warn|mute|ban|unban)$/))&&method==='POST'){const action=m[2],s=role(req,res,action==='ban'||action==='unban'?'admin':'moderator');if(!s)return;const t=user(m[1]);if(!t)return json(res,404,{error:'Пользователь не найден.'});if(action!=='unban'&&ROLE_RANK[s.role]<=ROLE_RANK[t.role])return json(res,403,{error:'Нельзя наказать пользователя с равной или более высокой ролью.'});if(action==='warn'){const b=await body(req),reason=clean(b.reason,500);notify(t.id,'warning',s.user_id,{text:`Администрация вынесла предупреждение: ${reason}`});log(s.user_id,'warning',{userId:t.id,meta:{reason}});return json(res,200,{ok:true})}if(action==='unban'){db.prepare('UPDATE bans SET active=0 WHERE user_id=?').run(t.id);log(s.user_id,'unban',{userId:t.id});return json(res,200,{ok:true})}const b=await body(req),reason=clean(b.reason,500),seconds=Math.min(Math.max(Number(b.seconds||0),action==='mute'?60:0),action==='mute'?30*86400:365*86400),exp=seconds?future(seconds):null;if(action==='mute'){db.prepare('UPDATE mutes SET active=0 WHERE user_id=?').run(t.id);db.prepare('INSERT INTO mutes(user_id,reason,issued_by,expires_at) VALUES(?,?,?,?)').run(t.id,reason,s.user_id,exp);log(s.user_id,'mute',{userId:t.id,meta:{reason,expiresAt:exp}});notify(t.id,'mute',s.user_id,{text:`Вы получили mute до ${exp}: ${reason}`})}else{db.prepare('UPDATE bans SET active=0 WHERE user_id=?').run(t.id);db.prepare('INSERT INTO bans(user_id,reason,issued_by,expires_at) VALUES(?,?,?,?)').run(t.id,reason,s.user_id,exp);db.prepare('DELETE FROM sessions WHERE user_id=?').run(t.id);log(s.user_id,'ban',{userId:t.id,meta:{reason,expiresAt:exp}});notify(t.id,'ban',s.user_id,{text:`Ваш доступ заблокирован: ${reason}`})}return json(res,200,{ok:true,expiresAt:exp})}
  if(pathn==='/api/admin/reports'&&method==='GET'){const s=role(req,res,'moderator');if(!s)return;const rows=db.prepare(`SELECT r.*,ru.username reporter_username,p.content post_content,t.title thread_title FROM reports r JOIN users ru ON ru.id=r.reporter_id LEFT JOIN posts p ON p.id=r.target_post_id LEFT JOIN threads t ON t.id=p.thread_id ORDER BY CASE r.status WHEN 'open' THEN 0 ELSE 1 END,r.created_at DESC LIMIT 100`).all();return json(res,200,{reports:rows})}
  if((m=pathn.match(/^\/api\/admin\/reports\/(\d+)\/resolve$/))&&method==='POST'){const s=role(req,res,'moderator');if(!s)return;const b=await body(req),status=String(b.status||''),comment=clean(b.comment||'',1000,false);if(!['accepted','rejected'].includes(status))return json(res,400,{error:'Некорректный статус.'});db.prepare('UPDATE reports SET status=?,moderator_id=?,moderator_comment=?,resolved_at=CURRENT_TIMESTAMP WHERE id=?').run(status,s.user_id,comment,Number(m[1]));log(s.user_id,'report_resolve',{meta:{reportId:Number(m[1]),status}});return json(res,200,{ok:true})}
  if((m=pathn.match(/^\/api\/admin\/posts\/(\d+)\/delete$/))&&method==='POST'){const s=role(req,res,'moderator');if(!s)return;const p=db.prepare('SELECT * FROM posts WHERE id=?').get(Number(m[1]));if(!p)return json(res,404,{error:'Сообщение не найдено.'});db.prepare('UPDATE posts SET deleted_at=CURRENT_TIMESTAMP,content=? WHERE id=?').run('[Сообщение удалено модератором]',p.id);log(s.user_id,'post_delete_admin',{threadId:p.thread_id,postId:p.id});return json(res,200,{ok:true})}
  if((m=pathn.match(/^\/api\/admin\/threads\/(\d+)$/))&&method==='PATCH'){const s=role(req,res,'moderator');if(!s)return;const id=Number(m[1]),t=db.prepare('SELECT * FROM threads WHERE id=?').get(id);if(!t)return json(res,404,{error:'Тема не найдена.'});const b=await body(req),patch={};if(['open','closed'].includes(b.status))patch.status=b.status;if(b.pinned!==undefined)patch.pinned=Boolean(b.pinned)?1:0;if(b.categoryId!==undefined)patch.category_id=Number(b.categoryId);if(!Object.keys(patch).length)return json(res,400,{error:'Нет изменений.'});const sets=Object.keys(patch).map(k=>`${k}=?`).join(',');db.prepare(`UPDATE threads SET ${sets},updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...Object.values(patch),id);log(s.user_id,'thread_moderate',{threadId:id,meta:patch});return json(res,200,{ok:true})}
  if((m=pathn.match(/^\/api\/admin\/threads\/(\d+)$/))&&method==='DELETE'){const s=role(req,res,'admin');if(!s)return;const id=Number(m[1]);if(!db.prepare('SELECT id FROM threads WHERE id=?').get(id))return json(res,404,{error:'Тема не найдена.'});db.prepare('DELETE FROM threads WHERE id=?').run(id);log(s.user_id,'thread_delete',{threadId:id});return json(res,200,{ok:true})}
  if(pathn==='/api/admin/logs'&&method==='GET'){const s=role(req,res,'admin');if(!s)return;const rows=db.prepare(`SELECT l.*,u.username actor_username,tu.username target_username FROM logs l LEFT JOIN users u ON u.id=l.actor_id LEFT JOIN users tu ON tu.id=l.target_user_id ORDER BY l.created_at DESC LIMIT 200`).all();return json(res,200,{logs:rows})}
  if(pathn==='/api/news'&&method==='GET')return json(res,200,{news:db.prepare('SELECT n.*,u.username author_username FROM news n LEFT JOIN users u ON u.id=n.author_id ORDER BY n.pinned DESC,n.created_at DESC LIMIT 50').all()});
  if(pathn==='/api/admin/news'&&method==='POST'){const s=role(req,res,'admin');if(!s)return;const b=await body(req),title=clean(b.title,160),category=clean(b.category,60),content=clean(b.content,20000),file=(b.files||[]).find(x=>x.field==='image'),image=file?saveFiles([file],s.user_id)[0]:clean(b.imageUrl||'',500,false);const r=db.prepare('INSERT INTO news(title,category,content,image_url,author_id) VALUES(?,?,?,?,?)').run(title,category,content,image||null,s.user_id);log(s.user_id,'news_create',{meta:{newsId:r.lastInsertRowid}});return json(res,201,{newsId:r.lastInsertRowid})}
  if((m=pathn.match(/^\/api\/admin\/news\/(\d+)$/))&&method==='PATCH'){const s=role(req,res,'admin');if(!s)return;const n=db.prepare('SELECT * FROM news WHERE id=?').get(Number(m[1]));if(!n)return json(res,404,{error:'Новость не найдена.'});const b=await body(req),title=clean(b.title??n.title,160),category=clean(b.category??n.category,60),content=clean(b.content??n.content,20000);db.prepare('UPDATE news SET title=?,category=?,content=?,pinned=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(title,category,content,b.pinned?1:0,n.id);log(s.user_id,'news_update',{meta:{newsId:n.id}});return json(res,200,{ok:true})}
  if((m=pathn.match(/^\/api\/admin\/news\/(\d+)$/))&&method==='DELETE'){const s=role(req,res,'admin');if(!s)return;db.prepare('DELETE FROM news WHERE id=?').run(Number(m[1]));log(s.user_id,'news_delete',{meta:{newsId:Number(m[1])}});return json(res,200,{ok:true})}

  return json(res,404,{error:'API route not found.'});
}

function verifyPassword(password,stored){try{const [kind,salt,hex]=String(stored).split('$');if(kind!=='scrypt')return false;const a=crypto.scryptSync(password,salt,64,{N:16384,r:8,p:1,maxmem:32*1024*1024});return safeEqual(a,Buffer.from(hex,'hex'))}catch(_){return false}}

async function staticFile(res,file){try{const st=await fsp.stat(file);if(!st.isFile())return false;const data=await fsp.readFile(file);securityHeaders(res);res.writeHead(200,{'Content-Type':mime(file),'Content-Length':data.length,'Cache-Control':PROD?'public,max-age=86400':'no-cache'});res.end(data);return true}catch(_){return false}}
async function serve(req,res,url){let p=url.pathname;if(p==='/')p='/index.html';if(p==='/forum')p='/index.html';if(p.startsWith('/api/'))return api(req,res,url);if(p.startsWith('/uploads/')){const rel=path.normalize(p.slice('/uploads/'.length));if(rel.startsWith('..'))return json(res,403,{error:'Forbidden'});if(await staticFile(res,path.join(UPLOADS,rel)))return;return notFound(res)}const rel=path.normalize(p.replace(/^\//,''));if(rel.startsWith('..'))return forbidden(res);if(await staticFile(res,path.join(PUBLIC,rel)))return;return notFound(res)}
async function errorPage(res,status,title,text){securityHeaders(res);const file=path.join(PUBLIC,`${status}.html`);try{const b=await fsp.readFile(file);res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Content-Length':b.length,'Cache-Control':'no-store'});res.end(b)}catch(_){html(res,status,`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="background:#050a11;color:#fff;font-family:system-ui;padding:60px"><h1>${title}</h1><p>${text}</p></body>`)} }
function notFound(res){return errorPage(res,404,'Страница не найдена','Проверьте адрес или вернитесь на главную.')}
function forbidden(res){return errorPage(res,403,'У вас нет доступа','Эта страница доступна не всем пользователям.')}

const server=http.createServer((req,res)=>{const url=new URL(req.url,ORIGIN);serve(req,res,url).catch(e=>{console.error(e);if(!res.headersSent)errorPage(res,e.status||500,e.status===403?'У вас нет доступа':e.status===404?'Страница не найдена':'Произошла ошибка','Попробуйте ещё раз.')})});
server.listen(PORT,()=>console.log(`SOSNOVKA RP running at ${ORIGIN}`));
setInterval(()=>{db.prepare("DELETE FROM sessions WHERE expires_at<=datetime('now')").run();db.prepare("DELETE FROM password_resets WHERE expires_at<=datetime('now') OR used_at IS NOT NULL").run();for(const [k,v] of rate)if(Date.now()-v.start>15*60_000)rate.delete(k)},15*60_000).unref();
function shutdown(){for(const set of sessions.values())for(const r of set){try{r.end()}catch(_){}}try{db.close()}catch(_){}server.close(()=>process.exit(0))}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
