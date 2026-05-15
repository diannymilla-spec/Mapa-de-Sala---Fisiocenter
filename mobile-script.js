/* ═══════════════════════════════════════════════════════════════
   MOBILE EXPERIENCE — carregado após script.js
   ═══════════════════════════════════════════════════════════════
   Detecta mobile (≤768px) e injeta interface dedicada.
   Desktop fica intocado.
═══════════════════════════════════════════════════════════════ */

const IS_MOBILE = () => window.innerWidth <= 768;

// ── Estado mobile ──────────────────────────────────────────────
let mobileSelectedDate = fmt(new Date());
let mobileView = 'day';

// ── Override renderMain usando assignment (evita bug de hoisting) ──
const _originalRenderMain = renderMain;

renderMain = function () {
    if (!IS_MOBILE()) {
        const mc = document.getElementById('mainContent');
        const mw = document.getElementById('mobileWrapper');
        if (mc) mc.style.display = '';
        if (mw) mw.style.display = 'none';
        _originalRenderMain();
        return;
    }
    renderMobileShell();
};

// ── Shell principal ────────────────────────────────────────────
function renderMobileShell() {
    // Garante que o mainContent (desktop) fica oculto
    const mc = document.getElementById('mainContent');
    if (mc) mc.style.display = 'none';

    const unit   = S.units.find(u => u.id === S.currentUnit);
    const isEdit = isEditActive(S.currentUnit);

    let wrapper = document.getElementById('mobileWrapper');
    if (!wrapper) {
        wrapper = document.createElement('div');
        wrapper.id = 'mobileWrapper';
        wrapper.className = 'mobile-content-wrapper';
        document.body.appendChild(wrapper);
    }
    wrapper.style.display = '';

    wrapper.innerHTML =
        buildMobileTopbar(unit, isEdit) +
        (mobileView === 'day' ? buildDayStrip() : buildMonthStripHeader()) +
        `<div id="mobileMain">` +
        (mobileView === 'day' ? buildDayView() : buildMonthView()) +
        `</div>` +
        buildBottomNav(isEdit);

    bindMobileEvents();
}

// ── Topbar ─────────────────────────────────────────────────────
function buildMobileTopbar(unit, isEdit) {
    return `
    <div class="mobile-topbar">
      <div class="mobile-topbar-title">Mapa de Sala</div>
      <span class="mobile-unit-badge" onclick="openMobileUnitPicker()">${unit ? unit.name : '—'}</span>
      <button class="mobile-topbar-btn" onclick="toggleTheme()" title="Tema">🌓</button>
      <button class="mobile-topbar-btn ${isEdit ? 'edit-active' : ''}"
              onclick="${isEdit ? 'exitConfigMode()' : 'openLock()'}"
              title="${isEdit ? 'Modo edição ativo' : 'Entrar na edição'}">
        ${isEdit ? '🔓' : '🔒'}
      </button>
    </div>`;
}

// ── Carrossel de dias ──────────────────────────────────────────
function buildDayStrip() {
    const anchor   = monday(parse(mobileSelectedDate));
    const todayStr = fmt(new Date());
    const dow      = ['DOM','SEG','TER','QUA','QUI','SEX','SÁB'];

    let html = `<div class="mobile-day-strip">
      <div class="mobile-week-nav"><button onclick="mobilePrevWeek()">‹</button></div>`;

    for (let i = 0; i < 6; i++) {
        const d = new Date(anchor);
        d.setDate(anchor.getDate() + i);
        const ds      = fmt(d);
        const isToday = ds === todayStr;
        const isSel   = ds === mobileSelectedDate;
        html += `
        <div class="mobile-day-chip ${isToday ? 'today' : ''} ${isSel ? 'selected' : ''}"
             onclick="selectMobileDay('${ds}')">
          <span class="chip-dow">${dow[d.getDay()]}</span>
          <span class="chip-num">${d.getDate()}</span>
        </div>`;
    }

    html += `<div class="mobile-week-nav"><button onclick="mobileNextWeek()">›</button></div>
    </div>`;
    return html;
}

// ── Header mensal ──────────────────────────────────────────────
function buildMonthStripHeader() {
    const monthNames = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                        'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    return `
    <div class="mobile-day-strip" style="justify-content:space-between;padding:6px 12px;">
      <button onclick="mobileNavMonth(-1)"
              style="background:var(--s3);border:1px solid var(--border);border-radius:6px;padding:6px 14px;color:var(--t2);font-size:16px;cursor:pointer;">‹</button>
      <span style="font-size:13px;font-weight:800;color:var(--text);">
        ${monthNames[S.monthMonth]} ${S.monthYear}
      </span>
      <button onclick="mobileNavMonth(1)"
              style="background:var(--s3);border:1px solid var(--border);border-radius:6px;padding:6px 14px;color:var(--t2);font-size:16px;cursor:pointer;">›</button>
    </div>`;
}

// ── Visão do DIA ───────────────────────────────────────────────
function buildDayView() {
    const unit = S.units.find(u => u.id === S.currentUnit);
    if (!unit) return '';

    const dt       = parse(mobileSelectedDate);
    const todayStr = fmt(new Date());
    const dayNames = ['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'];
    const dayLabel = `${dayNames[dt.getDay()]}, ${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}/${dt.getFullYear()}`;

    const rooms = unit.rooms.filter(r => {
        if (r.archived) return false;
        if (r.archivedFrom && mobileSelectedDate >= r.archivedFrom) return false;
        return true;
    });

    if (!rooms.length) {
        return `<div class="mobile-day-view">
          <div class="mobile-empty-day">
            <span class="empty-icon">🏥</span>
            <span class="empty-text">Nenhuma sala cadastrada nesta unidade.</span>
          </div>
        </div>`;
    }

    let cards = '';
    rooms.forEach(room => {
        const kM = `${unit.id}|${room.id}|${mobileSelectedDate}|manha`;
        const kT = `${unit.id}|${room.id}|${mobileSelectedDate}|tarde`;
        cards += `
        <div class="mobile-room-card">
          <div class="mobile-room-header">${room.name}</div>
          <div class="mobile-room-slots">
            ${buildMobileSlot(S.slots[kM], kM, 'Manhã')}
            ${buildMobileSlot(S.slots[kT], kT, 'Tarde')}
          </div>
        </div>`;
    });

    return `
    <div class="mobile-day-view">
      <div class="mobile-day-title">${mobileSelectedDate === todayStr ? '⭐ ' : ''}${dayLabel}</div>
      <div class="mobile-rooms-grid">${cards}</div>
    </div>`;
}

function buildMobileSlot(slot, key, periodLabel) {
    const isEdit = isEditActive(S.currentUnit);
    const click  = isEdit
        ? `onclick="openAlloc('${key}')"`
        : `onclick="showMobileSlotDetail('${key}')"`;

    if (!slot) {
        return `<div class="mobile-slot slot-empty" ${click}>
          <span class="mobile-slot-period">${periodLabel}</span>
          <span class="mobile-slot-name">${isEdit ? '+ Alocar' : 'Livre'}</span>
        </div>`;
    }

    if (slot.status === 'feriado') {
        return `<div class="mobile-slot slot-feriado" ${click}>
          <span class="mobile-slot-period">${periodLabel}</span>
          <span class="mobile-slot-name" style="color:var(--feriado);">🎉 Feriado</span>
        </div>`;
    }

    if (slot.status === 'manutencao') {
        return `<div class="mobile-slot" style="background:rgba(234,179,8,0.06);" ${click}>
          <span class="mobile-slot-period">${periodLabel}</span>
          <span class="mobile-slot-name" style="color:#ca8a04;">⚠️ Manutenção</span>
        </div>`;
    }

    const doc = S.doctors.find(d => d.id === slot.doctorId);
    if (!doc) {
        return `<div class="mobile-slot slot-empty" ${click}>
          <span class="mobile-slot-period">${periodLabel}</span>
          <span class="mobile-slot-name" style="color:var(--cancel);">⚠ Médico removido</span>
        </div>`;
    }

    const cleanName = doc.name.replace(/^(Dr\.|Dra\.)\s+/i, '');
    const nature    = slot.nature || doc.defNature || '';
    const typeTxt   = doc.type || 'hora';
    const tags = [];
    if (slot.status === 'canceled')         tags.push(`<span class="mobile-slot-tag tag-canceled">Cancelado</span>`);
    if (nature === 'Procedimento')           tags.push(`<span class="mobile-slot-tag tag-nature">Procedimento</span>`);
    if (nature === 'Consulta/Sessão')        tags.push(`<span class="mobile-slot-tag tag-nature">C/Sessão</span>`);
    if (typeTxt === 'hora')                  tags.push(`<span class="mobile-slot-tag tag-type">Hora marcada</span>`);

    return `
    <div class="mobile-slot slot-${slot.status}" ${click}>
      ${slot.obs ? `<span class="mobile-slot-obs">⚠️</span>` : ''}
      <span class="mobile-slot-period">${periodLabel}</span>
      <span class="mobile-slot-name">${cleanName}</span>
      <span class="mobile-slot-spec">${doc.spec}</span>
      ${tags.length ? `<div class="mobile-slot-tags">${tags.join('')}</div>` : ''}
    </div>`;
}

// ── Visão MENSAL ───────────────────────────────────────────────
function buildMonthView() {
    const todayStr = fmt(new Date());
    const dowShort = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
    const start    = new Date(S.monthYear, S.monthMonth, 1);
    const end      = new Date(S.monthYear, S.monthMonth + 1, 0);

    let rows = '';
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        if (d.getDay() === 0) continue; // pula domingo

        const ds      = fmt(d);
        const isToday = ds === todayStr;

        const daySlots = Object.entries(S.slots).filter(([k]) => {
            const p = k.split('|');
            return p[0] === S.currentUnit && p[2] === ds;
        });

        rows += `
        <div class="mobile-month-day-row ${isToday ? 'today-row' : ''}"
             onclick="selectMobileDay('${ds}'); mobileView='day'; renderMain();">
          <div class="mobile-month-day-date">
            <div class="dow">${dowShort[d.getDay()]}</div>
            <div class="num">${d.getDate()}</div>
          </div>
          <div class="mobile-month-day-slots">${buildMonthDayChips(daySlots)}</div>
          <div class="mobile-month-day-arrow">›</div>
        </div>`;
    }

    return `<div class="mobile-month-view">${rows || '<div style="padding:40px;text-align:center;color:var(--t3);">Sem dias neste mês.</div>'}</div>`;
}

function buildMonthDayChips(daySlots) {
    const MAX  = 3;
    const real = daySlots.filter(([,s]) => s.doctorId && s.status !== 'feriado' && s.status !== 'manutencao');
    const fer  = daySlots.find(([,s]) => s.status === 'feriado');

    if (fer) return `<span class="mobile-month-slot-chip chip-feriado">🎉 Feriado</span>`;

    const shown = real.slice(0, MAX);
    const rest  = real.length - shown.length;

    let html = shown.map(([key, slot]) => {
        const p    = key.split('|');
        const doc  = S.doctors.find(d => d.id === slot.doctorId);
        const name = doc ? doc.name.replace(/^(Dr\.|Dra\.)\s+/i, '').split(' ')[0] : '—';
        const per  = p[3] === 'manha' ? 'chip-manha' : 'chip-tarde';
        const can  = slot.status === 'canceled' ? 'chip-canceled' : '';
        return `<span class="mobile-month-slot-chip ${per} ${can}">${name}</span>`;
    }).join('');

    if (rest > 0) html += `<span class="mobile-month-more">+${rest}</span>`;
    if (!html) html = `<span style="font-size:10px;color:var(--t3);font-style:italic;">Livre</span>`;
    return html;
}

// ── Bottom Nav ─────────────────────────────────────────────────
function buildBottomNav(isEdit) {
    return `
    <nav class="mobile-bottom-nav">
      <button class="mobile-nav-btn ${mobileView==='day' ? 'active' : ''}"
              onclick="mobileView='day'; renderMain();">
        <span class="nav-icon">📅</span>
        <span class="nav-label">Dia</span>
      </button>
      <button class="mobile-nav-btn ${mobileView==='month' ? 'active' : ''}"
              onclick="mobileView='month'; renderMain();">
        <span class="nav-icon">🗓</span>
        <span class="nav-label">Mês</span>
      </button>
      <button class="mobile-nav-btn" onclick="openSearch()">
        <span class="nav-icon">🔍</span>
        <span class="nav-label">Buscar</span>
      </button>
      <button class="mobile-nav-btn" onclick="goToMobileToday()">
        <span class="nav-icon">⭐</span>
        <span class="nav-label">Hoje</span>
      </button>
    </nav>`;
}

// ── Interações ─────────────────────────────────────────────────
function selectMobileDay(ds) {
    mobileSelectedDate = ds;
    S.weekAnchor = fmt(monday(parse(ds)));
    renderMain();
}

function mobilePrevWeek() {
    const d = parse(mobileSelectedDate);
    d.setDate(d.getDate() - 7);
    mobileSelectedDate = fmt(d);
    S.weekAnchor = fmt(monday(d));
    renderMain();
}

function mobileNextWeek() {
    const d = parse(mobileSelectedDate);
    d.setDate(d.getDate() + 7);
    mobileSelectedDate = fmt(d);
    S.weekAnchor = fmt(monday(d));
    renderMain();
}

function mobileNavMonth(dir) {
    S.monthMonth += dir;
    if (S.monthMonth < 0)  { S.monthMonth = 11; S.monthYear--; }
    if (S.monthMonth > 11) { S.monthMonth = 0;  S.monthYear++; }
    renderMain();
}

function goToMobileToday() {
    const now = new Date();
    mobileSelectedDate = fmt(now);
    S.weekAnchor  = fmt(monday(now));
    S.monthYear   = now.getFullYear();
    S.monthMonth  = now.getMonth();
    mobileView = 'day';
    renderMain();
}

// ── Modal de detalhe (modo leitura) ───────────────────────────
function showMobileSlotDetail(key) {
    const slot = S.slots[key];
    if (!slot) return;

    const parts  = key.split('|');
    const unit   = S.units.find(u => u.id === parts[0]);
    const room   = unit?.rooms.find(r => r.id === parts[1]);
    const period = parts[3] === 'manha' ? 'Manhã' : 'Tarde';

    let content = '';

    if (slot.status === 'feriado') {
        content = `<p style="font-size:24px;text-align:center;padding:20px 0;">🎉 Feriado</p>`;
    } else if (slot.status === 'manutencao') {
        content = `<p style="font-size:24px;text-align:center;padding:20px 0;">⚠️ Em Manutenção</p>`;
    } else {
        const doc = S.doctors.find(d => d.id === slot.doctorId);
        if (doc) {
            const nature  = slot.nature || doc.defNature || 'Consulta';
            const typeTxt = doc.type === 'hora' ? 'Hora Marcada' : 'Ordem de Chegada';
            const pp = doc.priceParticular ? fmtPrice(doc.priceParticular) : null;
            const pc = doc.priceCartao     ? fmtPrice(doc.priceCartao)     : null;

            content = `
            <div style="display:flex;flex-direction:column;gap:12px;">
              <div>
                <div style="font-size:20px;font-weight:800;font-family:'Fraunces',serif;color:var(--text);">${doc.name}</div>
                <div style="font-size:12px;color:var(--t2);font-style:italic;margin-top:2px;">${doc.spec}</div>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                <div style="background:var(--s3);border-radius:8px;padding:10px;">
                  <div style="font-size:8px;font-weight:900;text-transform:uppercase;color:var(--t3);margin-bottom:4px;">Turno</div>
                  <div style="font-weight:700;">${period}</div>
                </div>
                <div style="background:var(--s3);border-radius:8px;padding:10px;">
                  <div style="font-size:8px;font-weight:900;text-transform:uppercase;color:var(--t3);margin-bottom:4px;">Sala</div>
                  <div style="font-weight:700;">${room ? room.name : '—'}</div>
                </div>
                <div style="background:var(--s3);border-radius:8px;padding:10px;">
                  <div style="font-size:8px;font-weight:900;text-transform:uppercase;color:var(--t3);margin-bottom:4px;">Natureza</div>
                  <div style="font-weight:700;">${nature}</div>
                </div>
                <div style="background:var(--s3);border-radius:8px;padding:10px;">
                  <div style="font-size:8px;font-weight:900;text-transform:uppercase;color:var(--t3);margin-bottom:4px;">Atendimento</div>
                  <div style="font-weight:700;">${typeTxt}</div>
                </div>
                ${slot.status === 'canceled' ? `
                <div style="background:rgba(224,92,92,0.1);border:1px solid rgba(224,92,92,0.3);border-radius:8px;padding:10px;grid-column:span 2;">
                  <div style="font-size:10px;font-weight:800;color:var(--cancel);">⛔ CANCELADO</div>
                </div>` : ''}
              </div>
              ${(pp || pc) ? `
              <div style="background:var(--s3);border-radius:8px;padding:12px;display:flex;gap:12px;">
                ${pp ? `<div style="flex:1;"><div style="font-size:8px;font-weight:900;text-transform:uppercase;color:var(--t3);margin-bottom:4px;">Particular</div><div style="font-size:16px;font-weight:800;color:var(--active);">${pp}</div></div>` : ''}
                ${pc ? `<div style="flex:1;"><div style="font-size:8px;font-weight:900;text-transform:uppercase;color:var(--t3);margin-bottom:4px;">Cartão Fisiocenter</div><div style="font-size:16px;font-weight:800;color:var(--active);">${pc}</div></div>` : ''}
              </div>` : ''}
              ${slot.obs ? `
              <div style="background:rgba(217,119,6,0.1);border:1px solid rgba(217,119,6,0.3);border-radius:8px;padding:10px;">
                <div style="font-size:8px;font-weight:900;text-transform:uppercase;color:var(--feriado);margin-bottom:4px;">⚠️ Observação</div>
                <div style="font-size:12px;color:var(--text);">${slot.obs}</div>
              </div>` : ''}
            </div>`;
        }
    }

    const modal = document.getElementById('allocModal');
    modal.querySelector('.modal-card').innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;">
        <h3 style="font-family:'Fraunces';font-size:16px;color:var(--accent);">Detalhes</h3>
        <button class="btn btn-ghost" style="padding:5px 10px;" onclick="closeAlloc()">✕</button>
      </div>
      ${content}
      <div style="margin-top:20px;">
        <button class="btn btn-ghost" style="width:100%;" onclick="closeAlloc()">Fechar</button>
      </div>`;
    modal.classList.add('open');
}

// ── Seletor de unidade mobile ──────────────────────────────────
function openMobileUnitPicker() {
    const active = S.units.filter(u => !u.archived);
    if (active.length <= 1) return;

    const options = active.map(u => `
      <button class="btn ${u.id === S.currentUnit ? 'btn-primary' : 'btn-ghost'}"
              style="width:100%;margin-bottom:8px;justify-content:flex-start;padding:14px 16px;font-size:13px;text-align:left;"
              onclick="changeUnit('${u.id}'); closeAlloc();">
        ${u.name}
      </button>`).join('');

    const modal = document.getElementById('allocModal');
    modal.querySelector('.modal-card').innerHTML = `
      <h3 style="font-family:'Fraunces';font-size:16px;color:var(--accent);margin-bottom:20px;">Selecionar Unidade</h3>
      ${options}
      <button class="btn btn-ghost" style="width:100%;margin-top:4px;" onclick="closeAlloc()">Cancelar</button>`;
    modal.classList.add('open');
}

// ── Swipe para trocar de dia ───────────────────────────────────
function bindMobileEvents() {
    const main = document.getElementById('mobileMain');
    if (!main || mobileView !== 'day') return;

    let sx = 0, sy = 0;
    main.addEventListener('touchstart', e => {
        sx = e.touches[0].clientX;
        sy = e.touches[0].clientY;
    }, { passive: true });

    main.addEventListener('touchend', e => {
        const dx = e.changedTouches[0].clientX - sx;
        const dy = e.changedTouches[0].clientY - sy;
        if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;

        const d = parse(mobileSelectedDate);
        if (dx < 0) {
            d.setDate(d.getDate() + 1);
            if (d.getDay() === 0) d.setDate(d.getDate() + 1);
        } else {
            d.setDate(d.getDate() - 1);
            if (d.getDay() === 0) d.setDate(d.getDate() - 1);
        }
        selectMobileDay(fmt(d));
    }, { passive: true });
}

// ── Responsividade: re-renderiza ao redimensionar ─────────────
let _mobileResizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(_mobileResizeTimer);
    _mobileResizeTimer = setTimeout(renderMain, 150);
});

// ── Service Worker (PWA) ───────────────────────────────────────
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
}
