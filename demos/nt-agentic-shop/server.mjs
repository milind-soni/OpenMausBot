#!/usr/bin/env node
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://${HOST}:${PORT}`).replace(/\/$/, '');
const STEP_SECONDS = Number(process.env.SHIP_STEP_SECONDS || 20);

const PRODUCTS = [
  { sku: 'NT-MS-001', name: 'เมาส์ไร้สาย NT Wireless Mouse M1', keywords: ['เมาส์', 'mouse', 'ไร้สาย', 'wireless'], price: 599, stock: 42 },
  { sku: 'NT-MS-002', name: 'เมาส์ไร้สาย NT Silent Mouse S2 (เสียงเงียบ)', keywords: ['เมาส์', 'mouse', 'ไร้สาย', 'wireless', 'เงียบ', 'silent'], price: 790, stock: 0 },
  { sku: 'NT-KB-001', name: 'คีย์บอร์ดไร้สาย NT Keyboard K1', keywords: ['คีย์บอร์ด', 'keyboard', 'ไร้สาย'], price: 1290, stock: 15 },
  { sku: 'NT-HS-001', name: 'หูฟังบลูทูธ NT Headset H1', keywords: ['หูฟัง', 'headset', 'bluetooth', 'บลูทูธ'], price: 1490, stock: 8 },
];

const ROUTE = [
  { status: 'รอคลังจัดสินค้า', location: 'คลังสินค้า NT แจ้งวัฒนะ' },
  { status: 'คลังแพ็กสินค้าเรียบร้อย', location: 'คลังสินค้า NT แจ้งวัฒนะ' },
  { status: 'ขนส่งรับพัสดุแล้ว', location: 'คลังสินค้า NT แจ้งวัฒนะ' },
  { status: 'ถึงศูนย์คัดแยก', location: 'ศูนย์คัดแยกหลักสี่ กรุงเทพฯ' },
  { status: 'ถึงศูนย์กระจายสินค้าปลายทาง', location: 'ศูนย์กระจายสินค้าปลายทาง' },
  { status: 'กำลังนำจ่าย', location: 'อยู่กับพนักงานนำจ่าย' },
  { status: 'ส่งสำเร็จ', location: 'ถึงผู้รับแล้ว' },
];

let state;
function reset() {
  state = {
    products: PRODUCTS.map((p) => ({ ...p })),
    orders: [],
    tickets: [],
    log: [],
    seq: 1000,
  };
}
reset();

const nextId = (prefix) => `${prefix}-${++state.seq}`;
const now = () => new Date().toISOString();
const findOrder = (id) => state.orders.find((o) => o.id === String(id || '').trim().toUpperCase());

function shipmentStep(order) {
  if (!order.shipment) return null;
  const elapsed = (Date.now() - order.shipment.startedAt) / 1000;
  const auto = Math.floor(elapsed / STEP_SECONDS);
  return Math.min(ROUTE.length - 1, Math.max(auto, order.shipment.manualStep));
}

function shipmentView(order) {
  const step = shipmentStep(order);
  if (step === null) return null;
  const leg = ROUTE[step];
  const location = step === 4 ? `ศูนย์กระจายสินค้า ${order.province}` : leg.location;
  const eta = new Date(order.shipment.startedAt + 2 * 86400000);
  return {
    tracking_no: order.shipment.trackingNo,
    carrier: 'NT Express',
    status: leg.status,
    latest_location: location,
    step: step + 1,
    total_steps: ROUTE.length,
    delivered: step === ROUTE.length - 1,
    estimated_delivery: step === ROUTE.length - 1 ? 'ส่งถึงแล้ว' : eta.toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    history: ROUTE.slice(0, step + 1).map((r, i) => ({
      status: r.status,
      location: i === 4 ? `ศูนย์กระจายสินค้า ${order.province}` : r.location,
    })),
  };
}

function guessProvince(address) {
  const m = String(address).match(/(?:จ\.|จังหวัด)\s*([^\s,]+)/);
  if (m) return m[1];
  if (/กรุงเทพ|กทม/.test(address)) return 'กรุงเทพฯ';
  return 'ปลายทาง';
}

const TOOLS = [
  {
    name: 'check_product',
    system: 'ระบบสต็อกและราคา',
    description: 'ค้นหาสินค้าในระบบสต็อก NT Shop: คืนรหัสสินค้า (sku) ราคา จำนวนคงเหลือ และพร้อมส่งหรือไม่',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'ชื่อหรือคำค้นสินค้า เช่น "เมาส์ไร้สาย"' } },
      required: ['query'],
    },
    run({ query }) {
      const q = String(query || '').toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      const hits = state.products.filter((p) =>
        words.some((w) => p.name.toLowerCase().includes(w) || p.keywords.some((k) => w.includes(k) || k.includes(w)) || p.sku.toLowerCase() === w),
      );
      return {
        results: (hits.length ? hits : state.products).map((p) => ({
          sku: p.sku,
          name: p.name,
          price_thb: p.price,
          stock: p.stock,
          ready_to_ship: p.stock > 0,
        })),
        note: hits.length ? undefined : 'ไม่พบสินค้าที่ตรงคำค้น แสดงสินค้าทั้งหมดแทน',
      };
    },
  },
  {
    name: 'create_order',
    system: 'ระบบคำสั่งซื้อ',
    description: 'สร้างคำสั่งซื้อและจองสต็อก ใช้เมื่อลูกค้ายืนยันสั่งซื้อแล้วและให้ชื่อ เบอร์โทร ที่อยู่จัดส่งครบ',
    inputSchema: {
      type: 'object',
      properties: {
        sku: { type: 'string' },
        quantity: { type: 'integer', minimum: 1 },
        customer_name: { type: 'string' },
        phone: { type: 'string' },
        address: { type: 'string', description: 'ที่อยู่จัดส่งเต็ม รวมจังหวัดและรหัสไปรษณีย์' },
      },
      required: ['sku', 'quantity', 'customer_name', 'phone', 'address'],
    },
    run({ sku, quantity, customer_name, phone, address }) {
      const p = state.products.find((x) => x.sku === String(sku).toUpperCase());
      if (!p) throw new Error(`ไม่พบสินค้า ${sku}`);
      const qty = Number(quantity);
      if (!Number.isInteger(qty) || qty < 1) throw new Error('จำนวนต้องเป็นจำนวนเต็มตั้งแต่ 1');
      if (p.stock < qty) throw new Error(`สต็อกไม่พอ: ${p.name} เหลือ ${p.stock} ชิ้น`);
      p.stock -= qty;
      const order = {
        id: nextId('ORD'),
        sku: p.sku,
        product: p.name,
        quantity: qty,
        unitPrice: p.price,
        total: p.price * qty,
        customer: customer_name,
        phone,
        address,
        province: guessProvince(address),
        status: 'รอชำระเงิน',
        paid: false,
        createdAt: now(),
      };
      state.orders.unshift(order);
      return { order_id: order.id, product: order.product, quantity: qty, total_thb: order.total, status: order.status };
    },
  },
  {
    name: 'create_payment_link',
    system: 'ระบบชำระเงิน',
    description: 'สร้างลิงก์ชำระเงินสำหรับคำสั่งซื้อ ส่งลิงก์นี้ให้ลูกค้า',
    inputSchema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
    run({ order_id }) {
      const o = findOrder(order_id);
      if (!o) throw new Error(`ไม่พบคำสั่งซื้อ ${order_id}`);
      if (o.paid) return { order_id: o.id, already_paid: true };
      o.payToken = o.payToken || randomBytes(6).toString('hex');
      o.payUrl = `${PUBLIC_URL}/pay/${o.id}?t=${o.payToken}`;
      return { order_id: o.id, amount_thb: o.total, payment_url: o.payUrl, expires_in_minutes: 30 };
    },
  },
  {
    name: 'check_payment_status',
    system: 'ระบบชำระเงิน',
    description: 'ตรวจสถานะการชำระเงินของคำสั่งซื้อ',
    inputSchema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
    run({ order_id }) {
      const o = findOrder(order_id);
      if (!o) throw new Error(`ไม่พบคำสั่งซื้อ ${order_id}`);
      return { order_id: o.id, paid: o.paid, amount_thb: o.total, paid_at: o.paidAt, method: o.paid ? 'PromptPay QR' : undefined };
    },
  },
  {
    name: 'send_to_warehouse',
    system: 'ระบบคลังสินค้า',
    description: 'ส่งใบงานให้คลังจัดสินค้าและเปิดเลขพัสดุ ทำได้เฉพาะคำสั่งซื้อที่ชำระเงินแล้ว',
    inputSchema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
    run({ order_id }) {
      const o = findOrder(order_id);
      if (!o) throw new Error(`ไม่พบคำสั่งซื้อ ${order_id}`);
      if (!o.paid) throw new Error('คำสั่งซื้อนี้ยังไม่ชำระเงิน ส่งใบงานให้คลังไม่ได้');
      if (o.ticketId) return { order_id: o.id, ticket_id: o.ticketId, tracking_no: o.shipment.trackingNo, already_sent: true };
      const ticket = { id: nextId('WH'), orderId: o.id, product: o.product, quantity: o.quantity, address: o.address, createdAt: now() };
      state.tickets.unshift(ticket);
      o.ticketId = ticket.id;
      o.status = 'ส่งคลังแล้ว';
      o.shipment = { trackingNo: `NTX${Date.now().toString().slice(-9)}TH`, startedAt: Date.now(), manualStep: 0 };
      return { order_id: o.id, ticket_id: ticket.id, warehouse: 'คลังสินค้า NT แจ้งวัฒนะ', tracking_no: o.shipment.trackingNo, carrier: 'NT Express' };
    },
  },
  {
    name: 'track_shipment',
    system: 'ระบบขนส่ง',
    description: 'ดึงสถานะพัสดุจากขนส่ง: ตำแหน่งล่าสุด ประวัติ และกำหนดส่ง ค้นด้วยเลขคำสั่งซื้อหรือเลขพัสดุ',
    inputSchema: {
      type: 'object',
      properties: { order_id: { type: 'string' }, tracking_no: { type: 'string' } },
    },
    run({ order_id, tracking_no }) {
      const o = order_id
        ? findOrder(order_id)
        : state.orders.find((x) => x.shipment && x.shipment.trackingNo === String(tracking_no || '').trim().toUpperCase());
      if (!o) throw new Error('ไม่พบพัสดุ ระบุ order_id หรือ tracking_no');
      if (!o.shipment) return { order_id: o.id, status: o.status, note: 'ยังไม่ได้ส่งเข้าคลัง จึงยังไม่มีเลขพัสดุ' };
      return { order_id: o.id, ...shipmentView(o) };
    },
  },
];

function logCall(tool, args, result, error) {
  state.log.unshift({ at: now(), tool: tool.name, system: tool.system, args, result, error });
  state.log = state.log.slice(0, 200);
}

const SERVER_INFO = { name: 'nt-shop', version: '1.0.0' };

function handleRpc(msg) {
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'ระบบหลังบ้าน NT Shop: สต็อก คำสั่งซื้อ ชำระเงิน คลัง และขนส่ง',
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(-32602, `Unknown tool ${params?.name}`);
      const args = params.arguments || {};
      try {
        const result = tool.run(args);
        logCall(tool, args, result);
        return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result });
      } catch (e) {
        logCall(tool, args, undefined, e.message);
        return ok({ content: [{ type: 'text', text: e.message }], isError: true });
      }
    }
    default:
      if (id === undefined) return null;
      return fail(-32601, `Method not found: ${method}`);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function payPage(o, token) {
  if (!o || o.payToken !== token) return '<h1 style="font-family:sans-serif">ลิงก์ชำระเงินไม่ถูกต้อง</h1>';
  const done = o.paid;
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ชำระเงิน ${esc(o.id)}</title>
<link href="https://fonts.googleapis.com/css2?family=Kanit:wght@400;600&display=swap" rel="stylesheet">
<style>
body{margin:0;font-family:Kanit,sans-serif;background:#fff8dc;color:#222;display:flex;justify-content:center;padding:24px 16px}
.card{background:#fff;border-radius:20px;box-shadow:0 8px 30px #0001;max-width:380px;width:100%;padding:24px;text-align:center}
.brand{font-weight:600;color:#c89200;letter-spacing:.5px}
.amt{font-size:40px;font-weight:600;margin:8px 0}
.qr{width:180px;height:180px;margin:16px auto;background:repeating-conic-gradient(#222 0 25%,#fff 0 50%) 0 0/22px 22px;border:10px solid #fff;outline:2px solid #eee;border-radius:8px}
button{width:100%;padding:14px;border:0;border-radius:12px;background:#ffc20e;font:600 18px Kanit,sans-serif;cursor:pointer}
.ok{font-size:64px;color:#1a9e4b}
.row{display:flex;justify-content:space-between;font-size:14px;color:#555;margin:4px 0}
</style></head><body><div class="card">
<div class="brand">NT Pay · ชำระเงินจำลอง (เดโม)</div>
${done ? `<div class="ok">✔</div><h2>ชำระเงินสำเร็จ</h2><p>ขอบคุณค่ะ กลับไปคุยกับผู้ช่วย NT ได้เลย</p>` : `
<div class="amt">฿${o.total.toLocaleString('th-TH')}</div>
<div class="row"><span>คำสั่งซื้อ</span><b>${esc(o.id)}</b></div>
<div class="row"><span>สินค้า</span><span>${esc(o.product)} × ${o.quantity}</span></div>
<div class="qr" aria-label="QR จำลอง"></div>
<form method="post"><button>จ่ายด้วย PromptPay (จำลอง)</button></form>`}
</div></body></html>`;
}

const DASHBOARD = String.raw`<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NT Shop Back Office</title>
<link href="https://fonts.googleapis.com/css2?family=Kanit:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--y:#ffc20e;--yl:#fff6d6;--ink:#1d1d1f;--mut:#6b6b70;--card:#fff;--bg:#faf7ee;--line:#eee3bf;--ok:#1a9e4b;--err:#d23b3b}
*{box-sizing:border-box}
body{margin:0;font-family:Kanit,sans-serif;background:var(--bg);color:var(--ink)}
header{background:var(--y);padding:14px 20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
header h1{margin:0;font-size:22px}
header .sub{font-size:14px;opacity:.8}
header button{margin-left:auto;border:0;background:#fff;border-radius:10px;padding:8px 14px;font:500 14px Kanit;cursor:pointer}
main{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:16px;padding:16px}
@media(max-width:900px){main{grid-template-columns:1fr}}
section{background:var(--card);border-radius:16px;padding:14px 16px;box-shadow:0 2px 10px #0000000d}
h2{margin:0 0 10px;font-size:17px;display:flex;align-items:center;gap:8px}
.log{display:flex;flex-direction:column;gap:8px;max-height:78vh;overflow:auto}
.call{border:1px solid var(--line);border-left:5px solid var(--y);border-radius:10px;padding:8px 10px;animation:pop .4s}
.call.err{border-left-color:var(--err)}
.call .top{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.call .sys{background:var(--yl);border-radius:6px;padding:1px 8px;font-size:13px}
.call code{font-size:14px;font-weight:600}
.call .t{margin-left:auto;color:var(--mut);font-size:12px}
.call pre{margin:6px 0 0;font-size:12px;white-space:pre-wrap;word-break:break-word;color:#444;max-height:140px;overflow:auto;background:#fbfaf6;border-radius:6px;padding:6px}
@keyframes pop{from{transform:translateY(-6px);opacity:0}to{transform:none;opacity:1}}
.grid{display:flex;flex-direction:column;gap:16px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:6px 4px;border-bottom:1px solid #f1ecd9;vertical-align:top}
th{color:var(--mut);font-weight:500}
.pill{border-radius:20px;padding:1px 10px;font-size:12px;white-space:nowrap;background:#eee}
.pill.paid{background:#dff5e6;color:var(--ok)}.pill.wait{background:#fff0c2}
.track{display:flex;gap:4px;margin-top:4px}.track i{flex:1;height:6px;border-radius:3px;background:#eee}.track i.on{background:var(--y)}
.empty{color:var(--mut);font-size:14px}
.mini{border:0;background:var(--yl);border-radius:8px;padding:2px 8px;font:12px Kanit;cursor:pointer}
</style></head><body>
<header><h1>NT Agentic AI · ระบบหลังบ้าน</h1><span class="sub">ทุกการกระทำของ AI แสดงที่นี่แบบเรียลไทม์</span><button id="reset">รีเซ็ตเดโม</button></header>
<main>
<section><h2>🤖 AI เรียกใช้ระบบ</h2><div class="log" id="log"></div></section>
<div class="grid">
<section><h2>📦 สต็อกสินค้า</h2><table id="stock"></table></section>
<section><h2>🧾 คำสั่งซื้อ</h2><table id="orders"></table></section>
<section><h2>🏭 ใบงานคลัง & 🚚 ขนส่ง</h2><table id="ship"></table></section>
</div></main>
<script>
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=t=>new Date(t).toLocaleTimeString('th-TH');
let lastLog='';
async function tick(){
  let s;try{s=await (await fetch('/api/state')).json()}catch{return}
  $('stock').innerHTML='<tr><th>สินค้า</th><th>ราคา</th><th>คงเหลือ</th></tr>'+s.products.map(p=>'<tr><td>'+esc(p.name)+'<br><small>'+p.sku+'</small></td><td>฿'+p.price+'</td><td>'+(p.stock>0?p.stock:'<span class="pill">หมด</span>')+'</td></tr>').join('');
  $('orders').innerHTML=s.orders.length?'<tr><th>เลขที่</th><th>ลูกค้า</th><th>ยอด</th><th>สถานะ</th></tr>'+s.orders.map(o=>'<tr><td>'+o.id+'</td><td>'+esc(o.customer)+'<br><small>'+esc(o.address)+'</small></td><td>฿'+o.total+'</td><td><span class="pill '+(o.paid?'paid':'wait')+'">'+(o.paid?'ชำระแล้ว':'รอชำระเงิน')+'</span><br><small>'+esc(o.status)+'</small></td></tr>').join(''):'<tr><td class="empty">ยังไม่มีคำสั่งซื้อ</td></tr>';
  const sh=s.orders.filter(o=>o.shipment);
  $('ship').innerHTML=sh.length?'<tr><th>ใบงาน / พัสดุ</th><th>สถานะล่าสุด</th></tr>'+sh.map(o=>'<tr><td>'+o.ticketId+'<br><small>'+o.shipment.tracking_no+'</small></td><td>'+esc(o.shipment.status)+' · '+esc(o.shipment.latest_location)+'<div class="track">'+Array.from({length:o.shipment.total_steps},(_,i)=>'<i class="'+(i<o.shipment.step?'on':'')+'"></i>').join('')+'</div>'+(o.shipment.delivered?'':'<button class="mini" data-adv="'+o.id+'">เลื่อนสถานะ ▶</button>')+'</td></tr>').join(''):'<tr><td class="empty">ยังไม่มีพัสดุ</td></tr>';
  const key=s.log.length+':'+(s.log[0]?.at||'');
  if(key!==lastLog){lastLog=key;
    $('log').innerHTML=s.log.length?s.log.map(l=>'<div class="call'+(l.error?' err':'')+'"><div class="top"><span class="sys">'+esc(l.system)+'</span><code>'+l.tool+'</code><span class="t">'+time(l.at)+'</span></div><pre>→ '+esc(JSON.stringify(l.args))+'\n← '+esc(l.error?'ผิดพลาด: '+l.error:JSON.stringify(l.result,null,1))+'</pre></div>').join(''):'<div class="empty">รอลูกค้าทักแชท… เมื่อ AI เรียกใช้ระบบใด จะขึ้นที่นี่</div>';}
}
document.addEventListener('click',async e=>{
  const id=e.target.dataset?.adv;if(id){await fetch('/api/advance/'+id,{method:'POST'});tick()}
});
$('reset').onclick=async()=>{if(confirm('ล้างคำสั่งซื้อและ log ทั้งหมด?')){await fetch('/api/reset',{method:'POST'});tick()}};
tick();setInterval(tick,1000);
</script></body></html>`;

function publicState() {
  return {
    products: state.products,
    orders: state.orders.map(({ payToken: _payToken, shipment, ...o }) => ({
      ...o,
      shipment: shipment ? shipmentView({ ...o, shipment }) : null,
    })),
    log: state.log,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  try {
    if (url.pathname === '/mcp') {
      if (req.method === 'GET') return send(res, 405, { error: 'SSE stream not supported; use POST' });
      if (req.method === 'DELETE') return send(res, 200, {});
      if (req.method !== 'POST') return send(res, 405, {});
      const body = JSON.parse(await readBody(req));
      const msgs = Array.isArray(body) ? body : [body];
      const replies = msgs.map(handleRpc).filter(Boolean);
      if (!replies.length) {
        res.writeHead(202);
        return res.end();
      }
      return send(res, 200, Array.isArray(body) ? replies : replies[0]);
    }
    const pay = url.pathname.match(/^\/pay\/([A-Z]+-\d+)$/);
    if (pay) {
      const o = findOrder(pay[1]);
      const token = url.searchParams.get('t');
      if (req.method === 'POST' && o && o.payToken === token && !o.paid) {
        o.paid = true;
        o.paidAt = now();
        o.status = 'ชำระเงินแล้ว รอส่งคลัง';
        state.log.unshift({ at: now(), tool: 'customer_paid', system: 'ลูกค้า (หน้าชำระเงิน)', args: { order_id: o.id }, result: { paid: true, amount_thb: o.total } });
        res.writeHead(303, { location: url.pathname + url.search });
        return res.end();
      }
      return send(res, 200, payPage(o, token), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/api/state') return send(res, 200, publicState());
    if (url.pathname === '/api/reset' && req.method === 'POST') {
      reset();
      return send(res, 200, { ok: true });
    }
    const adv = url.pathname.match(/^\/api\/advance\/([A-Z]+-\d+)$/);
    if (adv && req.method === 'POST') {
      const o = findOrder(adv[1]);
      if (o?.shipment) o.shipment.manualStep = Math.min(ROUTE.length - 1, shipmentStep(o) + 1);
      return send(res, 200, { ok: !!o });
    }
    if (url.pathname === '/' || url.pathname === '/dashboard') return send(res, 200, DASHBOARD, 'text/html; charset=utf-8');
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: e.message } });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`NT Shop demo
  Back office : ${PUBLIC_URL}/
  MCP (HTTP)  : ${PUBLIC_URL}/mcp`);
});
