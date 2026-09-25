import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getDailyScheduleGrid, formatThaiDate } from './booking.service';
import { config } from './config';

function todayInBangkok(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.business.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '01';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

interface ScheduleQuery {
  date?: string;
}

export async function scheduleRoutes(app: FastifyInstance) {
  // JSON data the page below polls. Public and read-only — it only ever
  // returns which hourly slots are free/booked, never any customer info.
  app.get('/api/schedule', async (request: FastifyRequest<{ Querystring: ScheduleQuery }>) => {
    const requested = request.query.date;
    const date = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : todayInBangkok();
    const grid = await getDailyScheduleGrid(date);
    return {
      date,
      dateLabel: formatThaiDate(date),
      openHour: config.business.openHour,
      closeHour: config.business.closeHour,
      courts: grid.map((c) => ({
        courtCode: c.court.court_code,
        courtName: c.court.court_name,
        slots: c.slots,
      })),
    };
  });

  app.get('/schedule', async (_request, reply) => {
    reply.type('text/html; charset=utf-8').send(SCHEDULE_PAGE_HTML);
  });
}

// Plain server-rendered page: vanilla HTML/CSS/JS, no build step, no
// external dependencies — it just polls /api/schedule and paints a grid.
const SCHEDULE_PAGE_HTML = `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ตารางจองคอร์ตเทนนิส</title>
<style>
  :root {
    --available-bg: #1e8e5a;
    --available-bg-hover: #197a4d;
    --booked-bg: #c0392b;
    --border: #e2e2e2;
    --text-muted: #6b7280;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px 16px 48px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Sarabun", Arial, sans-serif;
    background: #fafafa;
    color: #1a1a1a;
  }
  .wrap { max-width: 680px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  .subtitle { color: var(--text-muted); margin: 0 0 20px; font-size: 0.9rem; }
  .date-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 20px;
    flex-wrap: wrap;
  }
  .date-bar button {
    border: 1px solid var(--border);
    background: #fff;
    border-radius: 8px;
    padding: 8px 12px;
    font-size: 0.9rem;
    cursor: pointer;
  }
  .date-bar button:hover { background: #f0f0f0; }
  .date-bar input[type="date"] {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 10px;
    font-size: 0.9rem;
  }
  .date-label { font-weight: 600; margin-left: 4px; }
  .legend { display: flex; gap: 16px; margin-bottom: 16px; font-size: 0.85rem; color: var(--text-muted); }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .swatch { width: 14px; height: 14px; border-radius: 4px; display: inline-block; }
  .grid-scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: 12px; background: #fff; }
  table { border-collapse: collapse; width: 100%; min-width: 320px; }
  th, td { padding: 10px 8px; text-align: center; font-size: 0.88rem; }
  thead th { background: #f5f5f5; border-bottom: 1px solid var(--border); position: sticky; top: 0; }
  tbody th { text-align: left; color: var(--text-muted); font-weight: 500; white-space: nowrap; border-right: 1px solid var(--border); }
  tbody tr:not(:last-child) td, tbody tr:not(:last-child) th { border-bottom: 1px solid var(--border); }
  .cell { color: #fff; font-weight: 600; border-radius: 6px; margin: 3px; padding: 8px 4px; }
  .cell.available { background: var(--available-bg); }
  .cell.booked { background: var(--booked-bg); }
  .empty-state { padding: 40px 16px; text-align: center; color: var(--text-muted); }
  .updated { margin-top: 14px; font-size: 0.78rem; color: var(--text-muted); text-align: right; }
  footer { margin-top: 28px; font-size: 0.78rem; color: var(--text-muted); text-align: center; }
</style>
</head>
<body>
<div class="wrap">
  <h1>🎾 ตารางจองคอร์ตเทนนิส</h1>
  <p class="subtitle">Demo — อัปเดตแบบเรียลไทม์จากระบบจองผ่าน LINE</p>

  <div class="date-bar">
    <button id="prevDay" type="button" aria-label="วันก่อนหน้า">‹ ก่อนหน้า</button>
    <input type="date" id="datePicker" />
    <button id="nextDay" type="button" aria-label="วันถัดไป">ถัดไป ›</button>
    <button id="todayBtn" type="button">วันนี้</button>
    <span class="date-label" id="dateLabel"></span>
  </div>

  <div class="legend">
    <span><span class="swatch" style="background:var(--available-bg)"></span> ว่าง</span>
    <span><span class="swatch" style="background:var(--booked-bg)"></span> ไม่ว่าง</span>
  </div>

  <div class="grid-scroll">
    <table id="scheduleTable">
      <thead><tr><th></th></tr></thead>
      <tbody><tr><td class="empty-state">กำลังโหลด...</td></tr></tbody>
    </table>
  </div>

  <div class="updated" id="updatedAt"></div>

  <footer>อัปเดตอัตโนมัติทุก 20 วินาที · Tennis Booking Bot Demo</footer>
</div>

<script>
  const datePicker = document.getElementById('datePicker');
  const dateLabel = document.getElementById('dateLabel');
  const table = document.getElementById('scheduleTable');
  const updatedAt = document.getElementById('updatedAt');
  let pollTimer = null;

  function toDateInputValue(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return \`\${y}-\${m}-\${day}\`;
  }

  function todayBangkok() {
    // Read the current date as seen in Asia/Bangkok, regardless of the
    // viewer's own device timezone, so "วันนี้" always matches the server.
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
    return parts; // en-CA formats as YYYY-MM-DD
  }

  function shiftDate(dateStr, days) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    return toDateInputValue(new Date(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
  }

  async function loadSchedule(date) {
    try {
      const res = await fetch('/api/schedule?date=' + encodeURIComponent(date));
      const data = await res.json();
      renderTable(data);
      dateLabel.textContent = data.dateLabel;
      updatedAt.textContent = 'อัปเดตล่าสุด ' + new Date().toLocaleTimeString('th-TH');
    } catch (err) {
      table.querySelector('tbody').innerHTML = '<tr><td class="empty-state">โหลดข้อมูลไม่สำเร็จ</td></tr>';
    }
  }

  function renderTable(data) {
    const thead = table.querySelector('thead');
    const tbody = table.querySelector('tbody');

    thead.innerHTML = '<tr><th></th>' + data.courts.map((c) => \`<th>\${c.courtName}</th>\`).join('') + '</tr>';

    if (!data.courts.length || !data.courts[0].slots.length) {
      tbody.innerHTML = '<tr><td class="empty-state" colspan="99">ไม่มีข้อมูลคอร์ต</td></tr>';
      return;
    }

    const rows = data.courts[0].slots.map((_, i) => {
      const time = data.courts[0].slots[i].time;
      const cells = data.courts.map((c) => {
        const slot = c.slots[i];
        const cls = slot.available ? 'available' : 'booked';
        const label = slot.available ? 'ว่าง' : 'ไม่ว่าง';
        return \`<td><div class="cell \${cls}">\${label}</div></td>\`;
      }).join('');
      return \`<tr><th>\${time}</th>\${cells}</tr>\`;
    });
    tbody.innerHTML = rows.join('');
  }

  function setDate(date) {
    datePicker.value = date;
    if (pollTimer) clearInterval(pollTimer);
    loadSchedule(date);
    pollTimer = setInterval(() => loadSchedule(datePicker.value), 20000);
  }

  datePicker.addEventListener('change', () => setDate(datePicker.value));
  document.getElementById('prevDay').addEventListener('click', () => setDate(shiftDate(datePicker.value, -1)));
  document.getElementById('nextDay').addEventListener('click', () => setDate(shiftDate(datePicker.value, 1)));
  document.getElementById('todayBtn').addEventListener('click', () => setDate(todayBangkok()));

  setDate(todayBangkok());
</script>
</body>
</html>
`;
