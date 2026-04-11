// CONFIGURAÇÕES E ESTADO
const SUPABASE_URL = 'https://rqmdufikdxfvridzrbcn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_9E27fXvUfWzlY8jDosY8qg_omISB2JO';
const _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const DAYS_PT=['DOMINGO','SEGUNDA-FEIRA','TERÇA-FEIRA','QUARTA-FEIRA','QUINTA-FEIRA','SEXTA-FEIRA','SÁBADO'];
const MONTHS_PT=['JANEIRO','FEVEREIRO','MARÇO','ABRIL','MAIO','JUNHO','JULHO','AGOSTO','SETEMBRO','OUTUBRO','NOVEMBRO','DEZEMBRO'];

let S = {
  units: [
    {id:'u1', name:'AMBULATÓRIO', rooms: Array.from({length:5}, (_,i) => ({id:'r'+(i+1), name: `SALA ${i+1}`}))},
    {id:'u2', name:'FISIOTERAPIA', rooms: Array.from({length:7}, (_,i) => ({id:'rf'+(i+1), name: `SALA ${i+1}`}))},
    {id:'u3', name:'ABAETETUBA', rooms: []}
  ],
  doctors: [], slots: {}, currentUnit: 'u1', view: 'week',
  weekAnchor: null, monthYear: new Date().getFullYear(), monthMonth: new Date().getMonth()
};

// { unitId: true } para cada unidade desbloqueada. Admin desbloqueia todas.
let configActive = {};

// Mapa de role (retornado pela API) → nome da unidade no sistema
const ROLE_UNIT_NAME = {
    ambulatorio:  'AMBULATÓRIO',
    fisioterapia: 'FISIOTERAPIA',
    abaetetuba:   'ABAETETUBA'
};

function isEditActive(unitId) { return configActive[unitId] === true; }
function isAnyEditActive()    { return Object.values(configActive).some(Boolean); }

function updateConfigUI() {
    const anyActive     = isAnyEditActive();
    const currentActive = isEditActive(S.currentUnit);
    document.getElementById('cfgBadge').style.display      = anyActive     ? 'inline-block' : 'none';
    document.getElementById('cfgToggleBtn').style.color    = currentActive ? 'var(--active)' : '';
    document.getElementById('exitCfgBtn').style.display    = anyActive     ? 'flex' : 'none';
    document.getElementById('massAllocBtn').style.display  = currentActive ? 'flex' : 'none';
}
let isMassMode = false;
let massDocId = '';
let massNature = 'Consulta';
let massStatus = 'active';
let massDiaInteiro = false;

let curTgl = {
    tglPrefix:'Dr.',
    tglType:'hora',
    tglAllocStatus:'active',
    tglAllocScope:'periodo',
    tglAllocNature: 'Consulta',
    tglDefaultNature: ''
};

// ── FORÇAR TEXTOS (MAIÚSCULAS/TITLE CASE) ──
document.addEventListener('input', function(e) {
    if (e.target.tagName === 'INPUT' && e.target.type === 'text') {
        const start = e.target.selectionStart;
        const end = e.target.selectionEnd;
        let val = e.target.value;

        if (e.target.id === 'allocObs' || e.target.id === 'newUnitInp' || e.target.id === 'newRoomInp' || e.target.id.startsWith('edit-u-') || e.target.id.startsWith('edit-r-')) {
            e.target.value = val.toUpperCase();
        } else {
            e.target.value = val.toLowerCase().replace(/(?:^|\s)\S/g, function(a) { return a.toUpperCase(); });
        }
        e.target.setSelectionRange(start, end);
    }
});

// ── PERSISTÊNCIA ──

// Estado de navegação/UI → localStorage (não precisa ir ao banco)
function saveLocal() {
    localStorage.setItem('mds_ui_state', JSON.stringify({
        currentUnit: S.currentUnit,
        view: S.view,
        weekAnchor: S.weekAnchor,
        monthYear: S.monthYear,
        monthMonth: S.monthMonth,
        theme: S.theme
    }));
}

// Configurações (units + doctors) → Supabase mapa_config
async function saveConfig() {
    const { error } = await _supabase.from('mapa_config').upsert([
        { id: 'units',   data: S.units },
        { id: 'doctors', data: S.doctors }
    ]);
    if (error) { console.error('saveConfig:', error); showToast('ERRO AO SALVAR CONFIGURAÇÃO'); }
}

// Upsert de um único slot → Supabase mapa_slots
async function upsertSlot(key, slotData) {
    const { error } = await _supabase.from('mapa_slots').upsert({
        slot_key:  key,
        doctor_id: slotData.doctorId || null,
        status:    slotData.status,
        nature:    slotData.nature  || null,
        obs:       slotData.obs     || ''
    });
    if (error) { console.error('upsertSlot:', error); showToast('ERRO AO SALVAR SLOT'); }
}

// Upsert de múltiplos slots de uma vez
async function upsertSlots(slotsMap) {
    const rows = Object.entries(slotsMap).map(([key, data]) => ({
        slot_key:  key,
        doctor_id: data.doctorId || null,
        status:    data.status,
        nature:    data.nature  || null,
        obs:       data.obs     || ''
    }));
    if (!rows.length) return;
    const { error } = await _supabase.from('mapa_slots').upsert(rows);
    if (error) { console.error('upsertSlots:', error); showToast('ERRO AO SALVAR SLOTS'); }
}

// Remove um único slot
async function removeSlot(key) {
    const { error } = await _supabase.from('mapa_slots').delete().eq('slot_key', key);
    if (error) { console.error('removeSlot:', error); showToast('ERRO AO REMOVER SLOT'); }
}

// Remove múltiplos slots de uma vez
async function removeSlots(keys) {
    if (!keys.length) return;
    const { error } = await _supabase.from('mapa_slots').delete().in('slot_key', keys);
    if (error) { console.error('removeSlots:', error); showToast('ERRO AO REMOVER SLOTS'); }
}

async function init() {
    // 1. Carregar estado de UI do localStorage
    const uiState = localStorage.getItem('mds_ui_state');
    if (uiState) {
        try {
            const p = JSON.parse(uiState);
            S.currentUnit = p.currentUnit || S.currentUnit;
            S.view        = p.view        || S.view;
            S.weekAnchor  = p.weekAnchor  || null;
            S.monthYear   = p.monthYear   || S.monthYear;
            S.monthMonth  = p.monthMonth  !== undefined ? p.monthMonth : S.monthMonth;
            S.theme       = p.theme;
        } catch(e) {}
    }

    // 2. Carregar configurações do Supabase
    try {
        const { data: configRows, error: cfgErr } = await _supabase.from('mapa_config').select('*');
        if (!cfgErr && configRows && configRows.length > 0) {
            const unitsRow   = configRows.find(r => r.id === 'units');
            const doctorsRow = configRows.find(r => r.id === 'doctors');
            if (unitsRow?.data)   S.units   = unitsRow.data;
            if (doctorsRow?.data) S.doctors = doctorsRow.data;
        }

        // 3. Carregar slots do Supabase
        const { data: slotRows, error: slotErr } = await _supabase.from('mapa_slots').select('*');
        if (!slotErr && slotRows) {
            S.slots = {};
            slotRows.forEach(row => {
                if (row.slot_key) {
                    S.slots[row.slot_key] = {
                        doctorId: row.doctor_id,
                        status:   row.status,
                        nature:   row.nature,
                        obs:      row.obs || ''
                    };
                }
            });
        }
    } catch(e) {
        console.error('Erro ao carregar dados do Supabase:', e);
    }

    // 4. Aplicar tema salvo
    if (S.theme === 'light') {
        document.body.classList.remove('dark-theme');
        document.body.classList.add('light-theme');
    }

    if(!S.weekAnchor) {
        goToToday();
    } else {
        // Garante que o anchor sempre seja uma Segunda-feira
        const anchor = parse(S.weekAnchor);
        if (anchor.getDay() !== 1) {
            S.weekAnchor = fmt(monday(anchor));
            saveLocal();
        }
    }
    renderUnitSelect();
    renderMain();
}

// SEGURANÇA E ARRASTAR
function handleConfigTrigger() {
    if(isEditActive(S.currentUnit)) openConfig(); else openLock();
}

// DATAS
function monday(d){ const dt=new Date(d); const day=dt.getDay(); const diff = dt.getDate() - day + (day === 0 ? -6 : 1); return new Date(dt.setDate(diff)); }
function fmt(d){const y=d.getFullYear();const m=String(d.getMonth()+1).padStart(2,'0');const day=String(d.getDate()).padStart(2,'0');return `${y}-${m}-${day}`;}
function parse(s){const p=s.split('-');return new Date(+p[0],+p[1]-1,+p[2])}

function goToToday() {
  const now = new Date();
  S.weekAnchor = fmt(monday(now));
  S.monthYear = now.getFullYear(); S.monthMonth = now.getMonth();
  renderNavLabel(); renderMain(); saveLocal();
}

function navStep(dir) {
  if(S.view === 'week') {
    const d = parse(S.weekAnchor); d.setDate(d.getDate() + (dir * 7)); S.weekAnchor = fmt(monday(d));
  } else {
    S.monthMonth += dir;
    if(S.monthMonth < 0){ S.monthMonth=11; S.monthYear--; }
    else if(S.monthMonth > 11){ S.monthMonth=0; S.monthYear++; }
  }
  renderNavLabel(); renderMain(); saveLocal();
}

function renderNavLabel(){
  const el = document.getElementById('navLabel');
  if(S.view === 'week') {
    const mon=parse(S.weekAnchor); const sat=new Date(mon); sat.setDate(sat.getDate()+5);
    el.textContent = `${mon.getDate()} ${MONTHS_PT[mon.getMonth()].slice(0,3)} - ${sat.getDate()} ${MONTHS_PT[sat.getMonth()].slice(0,3)} ${sat.getFullYear()}`;
  } else {
    el.textContent = `${MONTHS_PT[S.monthMonth]} ${S.monthYear}`;
  }
}

function setView(v){
    if (isMassMode && v === 'week') {
        toggleMassMode();
    }
    S.view=v; renderNavLabel(); renderMain(); saveLocal();
}

// RENDERIZAÇÃO
function renderMain() {
  const el = document.getElementById('mainContent');
  const unit = S.units.find(u => u.id === S.currentUnit);
  if(!unit) { el.innerHTML = "Unidade não encontrada."; return; }

  let dates = [];
  const isMonthView = S.view === 'month';

  if(!isMonthView) {
    dates = Array.from({length:6}, (_,i) => {
      const d = parse(S.weekAnchor); d.setDate(d.getDate()+i); return fmt(d);
    });
  } else {
    const start = new Date(S.monthYear, S.monthMonth, 1);
    const end   = new Date(S.monthYear, S.monthMonth + 1, 0);
    // Recua até a Segunda da semana que contém o dia 1
    const startMonday = new Date(start);
    const dow = startMonday.getDay();
    if (dow !== 1) startMonday.setDate(startMonday.getDate() - (dow === 0 ? 6 : dow - 1));
    for(let d = new Date(startMonday); d <= end; d.setDate(d.getDate() + 1)) {
        if(d.getDay() !== 0) dates.push(fmt(d));
    }
  }

  let gridClass = isMonthView ? (isMassMode ? 'mass-grid' : 'month-grid') : '';

  let h = `<div class="days-grid ${gridClass}">`;
  dates.forEach(date => {
    const dt = parse(date);
    const isPrevMonth = isMonthView && dt.getMonth() !== S.monthMonth;
    const isToday = fmt(new Date()) === date;
    const dayName = DAYS_PT[dt.getDay()];

    h += `
    <div class="day-card${isPrevMonth ? ' day-card--prev-month' : ''}" style="${isToday ? 'border:2px solid var(--accent)' : ''}">
      <div class="day-header">${dayName} ${dt.getDate()}/${dt.getMonth()+1}</div>
      <table class="day-table">
        <thead>
          <tr>
            <th style="width:50px"></th>
            ${unit.rooms.map((r,i) => `<th class="room-th room-color-${i%5}">${r.name}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${['manha', 'tarde'].map(p => `
            <tr>
              <td class="side-label">${p === 'manha' ? 'MANHÃ' : 'TARDE'}</td>
              ${unit.rooms.map(r => {
                const key = `${unit.id}|${r.id}|${date}|${p}`;
                const slot = S.slots[key];
                return `
                <td class="cell-slot" id="td-${key}" onclick="openAlloc('${key}')"
                    ondragover="allowDrop(event)" ondragleave="handleDragLeave(event)" ondrop="handleDrop(event, '${key}')">
                  ${slotHTML(slot, key, isMonthView)}
                </td>`;
              }).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;
  });
  h += `</div>`;
  el.innerHTML = h;
  requestAnimationFrame(fitNames);
}

// Encolhe o font-size de cada nome até caber em 1 linha sem quebrar,
// depois sincroniza todas as linhas do mesmo slot para o menor tamanho encontrado
function fitNames() {
  // 1ª passagem: ajusta cada span individualmente
  document.querySelectorAll('.mini-name').forEach(el => {
    el.style.fontSize = '';
    const slot = el.closest('.mini-slot');
    if (!slot) return;
    const maxW = slot.clientWidth - 6;
    if (maxW <= 0) return;
    let size = parseFloat(window.getComputedStyle(el).fontSize);
    const minSize = 5.5;
    while (el.scrollWidth > maxW && size > minSize) {
      size -= 0.5;
      el.style.fontSize = size + 'px';
    }
  });

  // 2ª passagem: dentro de cada slot, iguala todos os spans ao menor tamanho
  document.querySelectorAll('.mini-slot').forEach(slot => {
    const spans = slot.querySelectorAll('.mini-name');
    if (spans.length <= 1) return;
    let minSize = Infinity;
    spans.forEach(s => {
      const sz = parseFloat(s.style.fontSize || window.getComputedStyle(s).fontSize);
      if (sz < minSize) minSize = sz;
    });
    spans.forEach(s => { s.style.fontSize = minSize + 'px'; });
  });
}

function slotHTML(slot, key, isMonthView) {
  if(!slot) return '';

  const draggableAttr = isEditActive(S.currentUnit) && !isMassMode ? 'true' : 'false';

  if(slot.status === 'feriado') {
      return `
      <div class="mini-slot feriado" title="FERIADO" draggable="${draggableAttr}" ondragstart="handleDragStart(event, '${key}')">
          ${isMonthView ? 'FER.' : 'FERIADO'}
      </div>`;
  }

  const doc = S.doctors.find(d => d.id === slot.doctorId);
  if(!doc) return '';

  const natureTxt = slot.nature || doc.nature;
  const typeTxt = doc.type || 'hora';

  const tags = [];

  if (!isMonthView) {
      if (slot.status === 'canceled') tags.push(`<span class="mtag mtag-status">CANCELADO</span>`);
      if (natureTxt === 'Procedimento') tags.push(`<span class="mtag mtag-nature">PROCEDIMENTO</span>`);
      if (typeTxt === 'hora') tags.push(`<span class="mtag mtag-type">HORA MARCADA</span>`);
  }

  const typeDisplay = typeTxt === 'hora' ? 'Hora Marcada' : 'Ordem de Chegada';
  let tooltip = `${doc.name}\nEspecialidade: ${doc.spec}\nNatureza: ${natureTxt}\nAtendimento: ${typeDisplay}`;

  let obsWarning = '';
  if (slot.obs) {
      obsWarning = `<span class="obs-icon" title="Observação: ${slot.obs}">⚠️</span>`;
      tooltip += `\nObservação: ${slot.obs}`;
  }

  let displayNameFull = doc.name.replace(/^(Dr\.|Dra\.)\s+/i, '');

  let nameHTML = '';
  if (isMonthView) {
      nameHTML = `<span class="mini-name">${displayNameFull.split(' ')[0]}</span>`;
  } else {
      const nameParts = displayNameFull.split(' ');
      nameHTML = `<span class="mini-name">${nameParts[0]}</span>`;
      if (nameParts.length > 1) nameHTML += `<span class="mini-name">${nameParts.slice(1).join(' ')}</span>`;
      nameHTML += `<span class="mini-spec">${doc.spec}</span>`;
  }

  return `
    <div class="mini-slot ${slot.status}" title="${tooltip}" draggable="${draggableAttr}" ondragstart="handleDragStart(event, '${key}')">
        ${obsWarning}
        ${nameHTML}
        ${(!isMonthView && tags.length > 0) ? `<div class="mini-tags">${tags.join('')}</div>` : ''}
    </div>`;
}

// DRAG AND DROP HANDLERS
function handleDragStart(e, key) {
    if(!isEditActive(S.currentUnit) || isMassMode) return;
    e.dataTransfer.setData("text", key);
}
function allowDrop(e) {
    if(!isEditActive(S.currentUnit) || isMassMode) return;
    e.preventDefault();
    e.currentTarget.classList.add('drag-over');
}
function handleDragLeave(e) {
    e.currentTarget.classList.remove('drag-over');
}
function handleDrop(e, targetKey) {
    if(!isEditActive(S.currentUnit) || isMassMode) return;
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');

    const sourceKey = e.dataTransfer.getData("text");
    if(sourceKey === targetKey) return;

    const sourceData = S.slots[sourceKey];
    if(!sourceData) return;

    const targetData = S.slots[targetKey];

    if(targetData) S.slots[sourceKey] = targetData;
    else delete S.slots[sourceKey];

    S.slots[targetKey] = sourceData;

    // Persistir no Supabase
    upsertSlot(targetKey, sourceData);
    if(targetData) upsertSlot(sourceKey, targetData);
    else removeSlot(sourceKey);

    renderMain(); showToast("HORÁRIO MOVIDO COM SUCESSO!");
}

// TOGGLE HANDLER
function setTgl(gid, btn, val) {
    document.querySelectorAll(`#${gid} .tgl-btn`).forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    if(gid === 'tglMassToolbarNature') massNature = val;
    if(gid === 'tglMassToolbarStatus') massStatus = val;
    else curTgl[gid] = val;
}

// ── ALOCAÇÃO EM MASSA (PINTURA / TOGGLE POR CLIQUE INTELIGENTE) ──
function toggleMassMode() {
    isMassMode = !isMassMode;
    const tbar = document.getElementById('massToolbar');
    const btn = document.getElementById('massAllocBtn');

    if(isMassMode) {
        tbar.style.display = 'flex';
        btn.classList.add('active');
        btn.innerHTML = "✖ FECHAR MASSA";
        btn.style.color = "var(--cancel)";
        btn.style.borderColor = "var(--cancel)";
        btn.style.background = "transparent";

        const sel = document.getElementById('massToolbarDoc');
        const unitDocs = S.doctors.filter(d => d.unitId === S.currentUnit && !d.archived);
        const sortedDocs = [...unitDocs].sort((a,b) => {
            const nA = a.name.replace(/^(Dr\.|Dra\.)\s+/i, '').trim();
            const nB = b.name.replace(/^(Dr\.|Dra\.)\s+/i, '').trim();
            return nA.localeCompare(nB);
        });
        sel.innerHTML = `<option value="">-- Escolher Médico --</option>` + sortedDocs.map(d => `<option value="${d.id}">${d.name}</option>`).join('');

        massDocId = '';
        S.view = 'month';
        renderNavLabel();

    } else {
        tbar.style.display = 'none';
        btn.classList.remove('active');
        btn.innerHTML = "⚡ EM MASSA";
        btn.style.color = "";
        btn.style.borderColor = "";
        btn.style.background = "";
        massDiaInteiro = false;
        const diaBtn = document.getElementById('btnMassDiaInteiro');
        if (diaBtn) diaBtn.classList.remove('active');
    }
    renderMain();
}

function toggleMassDiaInteiro(btn) {
    massDiaInteiro = !massDiaInteiro;
    btn.classList.toggle('active', massDiaInteiro);
}

function applyMassClickToSlot(key) {
    const parts = key.split('|');
    const unitId = parts[0];
    const date = parts[2];
    const unit = S.units.find(u => u.id === unitId);

    const massDoc = S.doctors.find(d => d.id === massDocId);
    const effectiveNature = (massDoc && massDoc.defaultNature) ? massDoc.defaultNature : massNature;

    if (massDiaInteiro) {
        const allKeys = [];
        if (massStatus === 'feriado') {
            // Feriado: todas as salas do dia
            unit.rooms.forEach(r => {
                allKeys.push(`${unitId}|${r.id}|${date}|manha`);
                allKeys.push(`${unitId}|${r.id}|${date}|tarde`);
            });
        } else {
            // Médico: apenas a sala clicada, manhã + tarde
            const roomId = parts[1];
            allKeys.push(`${unitId}|${roomId}|${date}|manha`);
            allKeys.push(`${unitId}|${roomId}|${date}|tarde`);
        }

        const anyFilled = allKeys.some(k => S.slots[k]);

        if (anyFilled) {
            allKeys.forEach(k => { delete S.slots[k]; });
            removeSlots(allKeys);
        } else {
            if (massStatus !== 'feriado' && !massDocId) { showToast("SELECIONE O MÉDICO NO MENU SUPERIOR!"); return; }
            const toAdd = {};
            allKeys.forEach(k => {
                if (massStatus === 'feriado') {
                    S.slots[k] = { status: 'feriado', doctorId: null };
                } else {
                    S.slots[k] = { doctorId: massDocId, status: massStatus, nature: effectiveNature, obs: '' };
                }
                toAdd[k] = S.slots[k];
            });
            upsertSlots(toAdd);
        }
    } else {
        const existing = S.slots[key];
        if (existing) {
            delete S.slots[key];
            removeSlot(key);
        } else {
            if (massStatus === 'feriado') {
                S.slots[key] = { status: 'feriado', doctorId: null };
            } else {
                if (!massDocId) { showToast("SELECIONE O MÉDICO NO MENU SUPERIOR!"); return; }
                S.slots[key] = { doctorId: massDocId, status: massStatus, nature: effectiveNature, obs: '' };
            }
            upsertSlot(key, S.slots[key]);
        }
    }

    renderMain();
}

// ALOCAÇÃO SIMPLES (MODAL) E EXCLUSÃO
function openAlloc(key) {
  if(!isEditActive(S.currentUnit)) { openLock(); return; }

  if(isMassMode) { applyMassClickToSlot(key); return; }

  const slot = S.slots[key];
  document.getElementById('allocKey').value = key;
  document.getElementById('allocModal').classList.add('open');

  const sel = document.getElementById('allocDocId');
  const unitDocs = S.doctors.filter(d => d.unitId === S.currentUnit && !d.archived);
  const sortedDocs = [...unitDocs].sort((a, b) => {
      const nameA = a.name.replace(/^(Dr\.|Dra\.)\s+/i, '').trim();
      const nameB = b.name.replace(/^(Dr\.|Dra\.)\s+/i, '').trim();
      return nameA.localeCompare(nameB);
  });

  sel.innerHTML = `<option value="">Médico...</option>` + sortedDocs.map(d => `<option value="${d.id}" ${slot?.doctorId === d.id ? 'selected' : ''}>${d.name}</option>`).join('');

  document.getElementById('btnDelAlloc').style.display = slot ? 'block' : 'none';

  const st = slot ? slot.status : 'active';
  const nt = slot ? (slot.nature || 'Consulta') : 'Consulta';

  setTgl('tglAllocStatus', document.querySelector(`#tglAllocStatus .tgl-btn[onclick*="'${st}'"]`), st);
  setTgl('tglAllocNature', document.querySelector(`#tglAllocNature .tgl-btn[onclick*="'${nt}'"]`), nt);
  setTgl('tglAllocScope', document.querySelector(`#tglAllocScope .tgl-btn[onclick*="'periodo'"]`), 'periodo');

  document.getElementById('allocObs').value = slot?.obs || '';
}

function closeAlloc() { document.getElementById('allocModal').classList.remove('open'); }

function saveAllocation() {
  const key    = document.getElementById('allocKey').value;
  const docId  = document.getElementById('allocDocId').value;
  const status = curTgl.tglAllocStatus;
  const scope  = curTgl.tglAllocScope;
  const obs    = document.getElementById('allocObs').value.trim();
  const doc    = S.doctors.find(d => d.id === docId);
  const nature = (doc && doc.defaultNature) ? doc.defaultNature : curTgl.tglAllocNature;

  if(!docId && status !== 'feriado') { showToast("SELECIONE UM MÉDICO!"); return; }

  const unit  = S.units.find(u => u.id === S.currentUnit);
  const parts = key.split('|');
  const date  = parts[2];
  const period = parts[3];

  const toSave = {};

  if (status === 'feriado') {
      unit.rooms.forEach(room => {
          const k1 = `${unit.id}|${room.id}|${date}|${period}`;
          S.slots[k1] = { status: 'feriado', doctorId: null };
          toSave[k1] = S.slots[k1];
          if (scope === 'diatodo') {
              const otherPeriod = period === 'manha' ? 'tarde' : 'manha';
              const k2 = `${unit.id}|${room.id}|${date}|${otherPeriod}`;
              S.slots[k2] = { status: 'feriado', doctorId: null };
              toSave[k2] = S.slots[k2];
          }
      });
      showToast(scope === 'diatodo' ? "DIA TODO MARCADO COMO FERIADO" : "TURNO MARCADO COMO FERIADO");
  } else {
      const apply = (k) => {
          S.slots[k] = { doctorId: docId, status, nature, obs };
          toSave[k] = S.slots[k];
      };
      apply(key);
      if(scope === 'diatodo') {
          apply(`${parts[0]}|${parts[1]}|${parts[2]}|${period === 'manha' ? 'tarde' : 'manha'}`);
      }
      showToast("ALOCAÇÃO SALVA!");
  }

  upsertSlots(toSave);
  closeAlloc(); renderMain();
}

function deleteAllocation() {
    const key    = document.getElementById('allocKey').value;
    const scope  = curTgl.tglAllocScope;
    const slot   = S.slots[key];
    const parts  = key.split('|');
    const unitId = parts[0];
    const roomId = parts[1];
    const date   = parts[2];
    const period = parts[3];

    const unit = S.units.find(u => u.id === unitId);
    const keysToDelete = [];

    if (slot && slot.status === 'feriado') {
        unit.rooms.forEach(r => {
            const k1 = `${unitId}|${r.id}|${date}|${period}`;
            delete S.slots[k1]; keysToDelete.push(k1);
            if (scope === 'diatodo') {
                const otherPeriod = period === 'manha' ? 'tarde' : 'manha';
                const k2 = `${unitId}|${r.id}|${date}|${otherPeriod}`;
                delete S.slots[k2]; keysToDelete.push(k2);
            }
        });
        showToast(scope === 'diatodo' ? "FERIADO REMOVIDO DO DIA TODO" : "FERIADO REMOVIDO DO TURNO");
    } else {
        delete S.slots[key]; keysToDelete.push(key);
        if (scope === 'diatodo') {
            const otherPeriod = period === 'manha' ? 'tarde' : 'manha';
            const k2 = `${unitId}|${roomId}|${date}|${otherPeriod}`;
            delete S.slots[k2]; keysToDelete.push(k2);
        }
        showToast("ALOCAÇÃO REMOVIDA!");
    }

    removeSlots(keysToDelete);
    closeAlloc(); renderMain();
}

// CONFIGURAÇÕES E SEGURANÇA
function openLock(){
    document.getElementById('lockOverlay').classList.add('open');
    document.getElementById('lockInp').value = '';
    setTimeout(() => document.getElementById('lockInp').focus(), 100);
}
function closeLock(){ document.getElementById('lockOverlay').classList.remove('open'); }

async function tryUnlock() {
    const password = document.getElementById('lockInp').value;
    try {
        const res = await fetch('/api/verify-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        const data = await res.json();
        if (data.ok) {
            if (data.role === 'admin') {
                // Senha mestra: desbloqueia todas as unidades
                S.units.forEach(u => { configActive[u.id] = true; });
                showToast("ACESSO TOTAL LIBERADO — TODAS AS UNIDADES");
            } else {
                // Senha de unidade: desbloqueia apenas a unidade correspondente
                const targetName = ROLE_UNIT_NAME[data.role];
                const unit = S.units.find(u => u.name.toUpperCase() === targetName);
                if (unit) {
                    configActive[unit.id] = true;
                    showToast(`EDIÇÃO LIBERADA: ${unit.name}`);
                } else {
                    showToast("UNIDADE NÃO ENCONTRADA PARA ESTA SENHA");
                }
            }
            updateConfigUI();
            closeLock();
            renderMain();
        } else {
            showToast("SENHA INCORRETA");
        }
    } catch (err) {
        showToast("ERRO AO VERIFICAR SENHA");
    }
}

function exitConfigMode() {
    if(isMassMode) toggleMassMode();
    configActive = {};
    updateConfigUI();
    closeConfig();
    showToast("MODO DE VISUALIZAÇÃO ATIVO (APENAS LEITURA)");
    renderMain();
}

function toggleTheme() {
    const isLight = document.body.classList.contains('light-theme');
    if(isLight) document.body.classList.replace('light-theme', 'dark-theme');
    else document.body.classList.replace('dark-theme', 'light-theme');
    S.theme = isLight ? 'dark' : 'light';
    saveLocal();
}

function openConfig(){
    document.getElementById('cfgPanel').classList.add('open');
    switchCfgTab('unidade');
}
function closeConfig(){
    document.getElementById('cfgPanel').classList.remove('open');
    renderMain();
}

function switchCfgTab(tab) {
  document.querySelectorAll('.cfg-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab'+tab.charAt(0).toUpperCase()+tab.slice(1)).classList.add('active');
  renderCfgBody(tab);
}

function renderCfgBody(tab) {
    const body = document.getElementById('cfgBody');
    const unit = S.units.find(u => u.id === S.currentUnit);

    if(tab === 'unidade') {
        body.innerHTML = `
            <div class="form-group"><label class="form-label">Cadastrar Nova Unidade</label>
            <div style="display:flex;gap:5px"><input class="inp" type="text" id="newUnitInp" placeholder="NOME DA UNIDADE..."><button class="btn btn-primary" onclick="addUnit()">+</button></div></div>
            <div style="margin-top:20px">${S.units.map(u => `
                <div class="cfg-row" id="row-u-${u.id}">
                    <span id="txt-u-${u.id}">${u.name}</span>
                    <div class="cfg-row-actions">
                        <button class="btn btn-edit" onclick="editUnit('${u.id}')">✎</button>
                        <button class="btn btn-danger" style="padding:5px 10px" onclick="deleteUnit('${u.id}')">✕</button>
                    </div>
                </div>`).join('')}</div>
        `;
    } else if(tab === 'medicos') {
        const sortByName = (a, b) => a.name.replace(/^(Dr\.|Dra\.)\s+/i, '').localeCompare(b.name.replace(/^(Dr\.|Dra\.)\s+/i, ''), 'pt-BR');
        const activeDocs   = S.doctors.filter(d => d.unitId === S.currentUnit && !d.archived).sort(sortByName);
        const archivedDocs = S.doctors.filter(d => d.unitId === S.currentUnit && d.archived).sort(sortByName);
        body.innerHTML = `
            <div class="form-group" style="margin-bottom:15px;">
                <label class="form-label" style="font-size:11px; text-transform:none; letter-spacing:0;">
                    Adicionando médicos na unidade: <strong style="color:var(--accent); text-transform:uppercase;">${unit.name}</strong>
                </label>
            </div>
            <div style="background:var(--s2);padding:15px;border-radius:4px;border:1px solid var(--border)">
                <div class="form-group"><label class="form-label">Título</label><div class="toggle-group" id="tglPrefix"><button class="tgl-btn active" onclick="setTgl('tglPrefix',this,'Dr.')">Dr.</button><button class="tgl-btn" onclick="setTgl('tglPrefix',this,'Dra.')">Dra.</button></div></div>
                <div class="form-group"><label class="form-label">Nome Completo</label><input type="text" class="inp" id="newDocName"></div>
                <div class="form-group"><label class="form-label">Especialidade</label><input type="text" class="inp" id="newDocSpec"></div>
                <div class="form-group"><label class="form-label">Tipo de Atendimento</label><div class="toggle-group" id="tglType"><button class="tgl-btn active" onclick="setTgl('tglType',this,'hora')">Hora Marcada</button><button class="tgl-btn" onclick="setTgl('tglType',this,'ordem')">Ordem de Chegada</button></div></div>
                <div class="form-group">
                    <label class="form-label">Natureza Padrão <span style="color:var(--t3);font-weight:400;text-transform:none;">(opcional — sobrepõe a agenda)</span></label>
                    <div class="toggle-group" id="tglDefaultNature">
                        <button class="tgl-btn active" onclick="setTgl('tglDefaultNature',this,'')">Nenhuma</button>
                        <button class="tgl-btn" onclick="setTgl('tglDefaultNature',this,'Consulta')">Consulta</button>
                        <button class="tgl-btn" onclick="setTgl('tglDefaultNature',this,'Procedimento')">Procedimento</button>
                    </div>
                </div>
                <button class="btn btn-primary" style="width:100%" onclick="addDoctor()">Cadastrar Médico</button>
            </div>

            <div style="margin-top:20px">${activeDocs.map(d => `
                <div class="cfg-row" id="row-d-${d.id}">
                    <div style="display:flex; flex-direction:column">
                        <strong id="txt-d-name-${d.id}">${d.name}</strong>
                        <small id="txt-d-spec-${d.id}">${d.spec}</small>
                    </div>
                    <div class="cfg-row-actions">
                        <button class="btn btn-edit" onclick="editDoctor('${d.id}')">✎</button>
                        <button class="btn btn-archive" onclick="archiveDoctor('${d.id}')" title="Arquivar profissional">⊘</button>
                        <button class="btn btn-danger" style="padding:5px 10px" onclick="deleteDoctor('${d.id}')">✕</button>
                    </div>
                </div>`).join('')}
            </div>

            ${archivedDocs.length > 0 ? `
            <div style="margin-top:24px; border-top:1px solid var(--border); padding-top:12px;">
                <div style="font-size:9px; font-weight:900; text-transform:uppercase; color:var(--t3); letter-spacing:1px; margin-bottom:10px;">
                    Arquivados (${archivedDocs.length})
                </div>
                ${archivedDocs.map(d => `
                <div class="cfg-row" id="row-d-${d.id}" style="opacity:0.55;">
                    <div style="display:flex; flex-direction:column">
                        <strong>${d.name}</strong>
                        <small>${d.spec}</small>
                    </div>
                    <div class="cfg-row-actions">
                        <button class="btn btn-primary" style="padding:5px 8px; font-size:9px;" onclick="unarchiveDoctor('${d.id}')">REATIVAR</button>
                        <button class="btn btn-danger" style="padding:5px 10px" onclick="deleteDoctor('${d.id}')">✕</button>
                    </div>
                </div>`).join('')}
            </div>` : ''}
        `;
    } else {
        body.innerHTML = `
            <div class="form-group"><label class="form-label">Adicionar Sala em: <strong style="color:var(--accent); text-transform:uppercase;">${unit.name}</strong></label>
            <div style="display:flex;gap:5px"><input class="inp" type="text" id="newRoomInp" placeholder="Ex: SALA 6"><button class="btn btn-primary" onclick="addRoom()">+</button></div></div>
            <div style="margin-top:20px">${unit.rooms.map(r => `
                <div class="cfg-row" id="row-r-${r.id}">
                    <span id="txt-r-${r.id}">${r.name}</span>
                    <div class="cfg-row-actions">
                        <button class="btn btn-edit" onclick="editRoom('${r.id}')">✎</button>
                        <button class="btn btn-danger" style="padding:5px 10px" onclick="deleteRoom('${r.id}')">✕</button>
                    </div>
                </div>`).join('')}</div>
        `;
    }
}

// EDIÇÃO DE DADOS
function editUnit(id) {
    const u = S.units.find(x => x.id === id);
    const row = document.getElementById(`row-u-${id}`);
    row.innerHTML = `
        <input class="inp" type="text" id="edit-u-${id}" value="${u.name}" style="flex:1; margin-right:5px; text-transform:uppercase;">
        <button class="btn btn-primary" style="padding:5px 10px" onclick="saveUnitEdit('${id}')">✓</button>
    `;
}
function saveUnitEdit(id) {
    const val = document.getElementById(`edit-u-${id}`).value.toUpperCase();
    const u = S.units.find(x => x.id === id);
    if(val && u) { u.name = val; saveConfig(); renderCfgBody('unidade'); renderUnitSelect(); }
}

function editRoom(id) {
    const unit = S.units.find(u => u.id === S.currentUnit);
    const room = unit.rooms.find(r => r.id === id);
    const row = document.getElementById(`row-r-${id}`);
    row.innerHTML = `
        <input class="inp" type="text" id="edit-r-${id}" value="${room.name}" style="flex:1; margin-right:5px">
        <button class="btn btn-primary" style="padding:5px 10px" onclick="saveRoomEdit('${id}')">✓</button>
    `;
}
function saveRoomEdit(id) {
    const val = document.getElementById(`edit-r-${id}`).value.toUpperCase();
    const unit = S.units.find(u => u.id === S.currentUnit);
    const room = unit.rooms.find(r => r.id === id);
    if(val && room) { room.name = val; saveConfig(); renderCfgBody('salas'); }
}

function setEditTgl(gid, btn) {
    document.querySelectorAll(`#${gid} .tgl-btn`).forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
}

function editDoctor(id) {
    const d = S.doctors.find(x => x.id === id);
    const row = document.getElementById(`row-d-${id}`);

    let prefix = d.name.startsWith('Dra.') ? 'Dra.' : 'Dr.';
    let cleanName = d.name.replace('Dr. ', '').replace('Dra. ', '');
    let type = d.type || 'hora';
    let defNature = d.defaultNature || '';

    row.innerHTML = `
        <div style="display:flex; flex-direction:column; flex:1; gap:8px">
            <div class="toggle-group" id="edit-tglPrefix-${id}">
                <button class="tgl-btn ${prefix === 'Dr.' ? 'active' : ''}" data-val="Dr." onclick="setEditTgl('edit-tglPrefix-${id}', this)">Dr.</button>
                <button class="tgl-btn ${prefix === 'Dra.' ? 'active' : ''}" data-val="Dra." onclick="setEditTgl('edit-tglPrefix-${id}', this)">Dra.</button>
            </div>
            <input type="text" class="inp" id="edit-d-name-${id}" value="${cleanName}" placeholder="Nome">
            <input type="text" class="inp" id="edit-d-spec-${id}" value="${d.spec}" placeholder="Especialidade">
            <div class="toggle-group" id="edit-tglType-${id}">
                <button class="tgl-btn ${type === 'hora' ? 'active' : ''}" data-val="hora" onclick="setEditTgl('edit-tglType-${id}', this)">Hora Marcada</button>
                <button class="tgl-btn ${type === 'ordem' ? 'active' : ''}" data-val="ordem" onclick="setEditTgl('edit-tglType-${id}', this)">Ordem de Chegada</button>
            </div>
            <label style="font-size:9px;color:var(--t3);font-weight:800;text-transform:uppercase;">Natureza Padrão <span style="font-weight:400;text-transform:none;">(opcional)</span></label>
            <div class="toggle-group" id="edit-tglDefNature-${id}">
                <button class="tgl-btn ${defNature === '' ? 'active' : ''}" data-val="" onclick="setEditTgl('edit-tglDefNature-${id}', this)">Nenhuma</button>
                <button class="tgl-btn ${defNature === 'Consulta' ? 'active' : ''}" data-val="Consulta" onclick="setEditTgl('edit-tglDefNature-${id}', this)">Consulta</button>
                <button class="tgl-btn ${defNature === 'Procedimento' ? 'active' : ''}" data-val="Procedimento" onclick="setEditTgl('edit-tglDefNature-${id}', this)">Procedimento</button>
            </div>
        </div>
        <div style="display:flex; flex-direction:column; gap:5px; margin-left:10px; align-items:center; justify-content:center;">
            <button class="btn btn-primary" style="padding:10px" onclick="saveDoctorEdit('${id}')" title="Salvar Alterações">✓</button>
            <button class="btn btn-ghost" style="padding:10px" onclick="renderCfgBody('medicos')" title="Cancelar">✕</button>
        </div>
    `;
}

function saveDoctorEdit(id) {
    const cleanName = document.getElementById(`edit-d-name-${id}`).value;
    const spec = document.getElementById(`edit-d-spec-${id}`).value;

    const prefixBtn = document.querySelector(`#edit-tglPrefix-${id} .active`);
    const prefix = prefixBtn ? prefixBtn.getAttribute('data-val') : 'Dr.';

    const typeBtn = document.querySelector(`#edit-tglType-${id} .active`);
    const type = typeBtn ? typeBtn.getAttribute('data-val') : 'hora';

    const defNatureBtn = document.querySelector(`#edit-tglDefNature-${id} .active`);
    const defaultNature = defNatureBtn ? defNatureBtn.getAttribute('data-val') : '';

    const d = S.doctors.find(x => x.id === id);
    if(cleanName && d) {
        d.name = prefix + ' ' + cleanName;
        d.spec = spec;
        d.type = type;
        d.defaultNature = defaultNature || null;
        saveConfig();
        renderCfgBody('medicos');
        showToast('MÉDICO ATUALIZADO COM SUCESSO!');
    }
}

// OPERAÇÕES BÁSICAS
function addUnit(){ const v=document.getElementById('newUnitInp').value.toUpperCase(); if(!v)return; S.units.push({id:'u'+Date.now(), name:v, rooms:[]}); saveConfig(); renderUnitSelect(); renderCfgBody('unidade'); }
function deleteUnit(id){ if(!confirm("EXCLUIR UNIDADE?"))return; S.units=S.units.filter(u=>u.id!==id); if(S.currentUnit===id)S.currentUnit=S.units[0]?.id||null; saveConfig(); renderUnitSelect(); renderCfgBody('unidade'); }

function addRoom(){ const v=document.getElementById('newRoomInp').value.toUpperCase(); const unit=S.units.find(u=>u.id===S.currentUnit); if(!v||!unit)return; unit.rooms.push({id:'r'+Date.now(), name:v}); saveConfig(); renderCfgBody('salas'); }
function deleteRoom(id){ const unit=S.units.find(u=>u.id===S.currentUnit); if(!unit)return; unit.rooms=unit.rooms.filter(r=>r.id!==id); saveConfig(); renderCfgBody('salas'); }

function addDoctor(){
    const name=document.getElementById('newDocName').value; if(!name)return;
    const spec=document.getElementById('newDocSpec').value || 'Geral';
    const doc = {id:'d'+Date.now(), name: curTgl.tglPrefix+' '+name, spec, type: curTgl.tglType, unitId: S.currentUnit};
    if (curTgl.tglDefaultNature) doc.defaultNature = curTgl.tglDefaultNature;
    S.doctors.push(doc);
    curTgl.tglDefaultNature = '';
    saveConfig(); renderCfgBody('medicos'); showToast("MÉDICO CADASTRADO NA UNIDADE ATUAL.");
}
function deleteDoctor(id){ if(!confirm("EXCLUIR MÉDICO?")) return; S.doctors=S.doctors.filter(d=>d.id!==id); saveConfig(); renderCfgBody('medicos'); }

function archiveDoctor(id) {
    const d = S.doctors.find(x => x.id === id);
    if(d) { d.archived = true; saveConfig(); renderCfgBody('medicos'); showToast("PROFISSIONAL ARQUIVADO"); }
}
function unarchiveDoctor(id) {
    const d = S.doctors.find(x => x.id === id);
    if(d) { d.archived = false; saveConfig(); renderCfgBody('medicos'); showToast("PROFISSIONAL REATIVADO"); }
}

function renderUnitSelect() { document.getElementById('unitSelect').innerHTML = S.units.map(u => `<option value="${u.id}" ${S.currentUnit===u.id?'selected':''}>${u.name}</option>`).join(''); }

function changeUnit(id) {
    S.currentUnit=id;
    updateConfigUI();

    if (isMassMode) {
        const sel = document.getElementById('massToolbarDoc');
        const unitDocs = S.doctors.filter(d => d.unitId === S.currentUnit && !d.archived);
        const sortedDocs = [...unitDocs].sort((a,b) => {
            const nA = a.name.replace(/^(Dr\.|Dra\.)\s+/i, '').trim();
            const nB = b.name.replace(/^(Dr\.|Dra\.)\s+/i, '').trim();
            return nA.localeCompare(nB);
        });
        sel.innerHTML = `<option value="">-- Escolher Médico --</option>` + sortedDocs.map(d => `<option value="${d.id}">${d.name}</option>`).join('');
        massDocId = '';
    }

    renderMain();
    if (document.getElementById('cfgPanel').classList.contains('open')) {
        const activeTabId = document.querySelector('.cfg-tab.active').id;
        if (activeTabId === 'tabSalas') renderCfgBody('salas');
        else if (activeTabId === 'tabMedicos') renderCfgBody('medicos');
    }
    saveLocal();
}

function showToast(m){ const t=document.getElementById('toast'); t.textContent=m.toUpperCase(); t.style.display='block'; setTimeout(()=>t.style.display='none', 2500); }

init();
