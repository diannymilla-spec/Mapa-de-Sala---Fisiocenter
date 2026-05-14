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
  doctors: [], slots: {}, priceEntries: [], currentUnit: 'u1', view: 'week',
  weekAnchor: null, monthYear: new Date().getFullYear(), monthMonth: new Date().getMonth()
};

// RealClinic – cache e estado de sincronização
let realClinicConvenios = [];
let realClinicProcedimentos = [];
let syncInProgress = false;
let lastSyncTime = null;
const REALCLINIC_CONVENIOS_FILTRO = ['Particular', 'Orçamento - Cartão Fisiocenter'];
const REALCLINIC_CONVENIO_MAP = {};

// { unitId: true } para cada unidade desbloqueada. Admin desbloqueia todas.
let configActive = {};
let isAdminActive = false;

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
    // Aba Unidades visível somente para ADM
    const tabUnEl = document.getElementById('tabUnidade');
    if (tabUnEl) tabUnEl.style.display = isAdminActive ? '' : 'none';
}
let isMassMode = false;
let massDocId = '';
let massNature = 'Consulta';
let massStatus = 'active';
let massDiaInteiro = false;

// Dashboard state
let dashRange = 'month';
let dashCustomStart = '';
let dashCustomEnd = '';
let dashGroupBy = 'week';

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

        if (e.target.id === 'searchInp') return;
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
        { id: 'units',        data: S.units },
        { id: 'doctors',      data: S.doctors },
        { id: 'priceEntries', data: S.priceEntries || [] }
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

// ── REALCLINIC – SYNC ──────────────────────────────────────────────────────

async function callRealClinicAPI(action, body = {}) {
  const response = await fetch('/api/realclinic-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...body })
  });
  if (!response.ok) { const e = await response.json(); throw new Error(e.error || 'Erro API RealClinic'); }
  return response.json();
}

async function syncRealClinicData() {
  if (syncInProgress) { showToast('Sincronização já em progresso...'); return; }
  syncInProgress = true;
  showToast('Sincronizando dados do RealClinic...');
  try {
    realClinicConvenios    = await callRealClinicAPI('list-convenios') || [];
    realClinicProcedimentos = await callRealClinicAPI('list-procedimentos') || [];
    realClinicConvenios.forEach(c => { REALCLINIC_CONVENIO_MAP[c.Nome] = c.Id; });
    lastSyncTime = new Date();
    showToast('✓ Sincronização com RealClinic concluída!');
    renderCfgBody('medicos');
  } catch (err) {
    showToast('✗ Erro ao sincronizar: ' + err.message);
  } finally {
    syncInProgress = false;
  }
}

async function syncDoctorProcedimentoValores(doctor) {
  if (!doctor.realClinicId) { showToast('Médico sem ID no RealClinic'); return null; }
  const unit = S.units.find(u => u.id === doctor.unitId);
  if (!unit?.realClinicId) { showToast('Unidade sem ID no RealClinic'); return null; }
  const procedimentoIds = (doctor.procedimentos || []).map(p => p.id);
  const convs = doctor.convenios || [];
  if (!procedimentoIds.length || !convs.length) { showToast('Médico sem procedimentos ou convênios'); return null; }
  showToast('Sincronizando valores...');
  try {
    const valores = await callRealClinicAPI('sync-doctor-valores', {
      idEmpresa: unit.realClinicId, docRealClinicId: doctor.realClinicId,
      procedimentoIds, convenioIds: convs.map(c => c.id), planoIds: convs.map(c => c.planoId)
    });
    convs.forEach(conv => {
      conv.procedimentos = valores.filter(v => v.convenioId === conv.id).map(v => ({
        id: v.procedimentoId,
        nome: realClinicProcedimentos.find(p => p.Id === v.procedimentoId)?.Nome || 'Proc. #' + v.procedimentoId,
        valor: v.valor
      }));
    });
    doctor.convenios = convs;
    saveConfig();
    showToast('✓ Valores do médico sincronizados!');
    return doctor;
  } catch (err) {
    showToast('✗ Erro ao sincronizar médico: ' + err.message);
    return null;
  }
}

function getAvailableProcedimentos() { return realClinicProcedimentos || []; }
function getFilteredConvenios() { return realClinicConvenios.filter(c => REALCLINIC_CONVENIOS_FILTRO.includes(c.Nome)); }

// ── TABELA DE PREÇOS ───────────────────────────────────────────────────────

function fmtPrice(val) {
    if (!val) return '';
    const num = parseFloat(String(val).replace(',', '.'));
    if (isNaN(num)) return String(val);
    return 'R$' + num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

let _priceSearch = '';

function renderPriceTable() {
  const el = document.getElementById('mainContent');
  const unit = S.units.find(u => u.id === S.currentUnit);
  if (!unit) { el.innerHTML = ''; return; }
  if (!S.priceEntries) S.priceEntries = [];

  const canEdit = isEditActive(S.currentUnit);
  const sortByName = (a, b) => a.name.replace(/^(Dr\.|Dra\.)\s+/i, '').localeCompare(b.name.replace(/^(Dr\.|Dra\.)\s+/i, ''), 'pt-BR');
  const q = _priceSearch.toLowerCase().trim();

  let doctors = S.doctors.filter(d => d.unitId === S.currentUnit && !d.archived).sort(sortByName);
  if (q) {
    doctors = doctors.filter(d => {
      if (d.name.toLowerCase().includes(q) || d.spec.toLowerCase().includes(q)) return true;
      return S.priceEntries.filter(e => e.doctorId === d.id && e.unitId === S.currentUnit).some(e =>
        (e.label || '').toLowerCase().includes(q) ||
        (e.priceParticular && fmtPrice(e.priceParticular).toLowerCase().includes(q)) ||
        (e.priceCartao     && fmtPrice(e.priceCartao).toLowerCase().includes(q))
      );
    });
  }

  // Auto-seed: médicos com Natureza=Consulta/C.Sessão e preços no perfil, mas sem entradas manuais ainda
  let autoSeeded = false;
  S.doctors.filter(d => d.unitId === S.currentUnit && !d.archived).forEach(d => {
    const hasEntries = S.priceEntries.some(e => e.doctorId === d.id && e.unitId === S.currentUnit);
    if (!hasEntries && (d.defNature === 'Consulta' || d.defNature === 'Consulta/Sessão') && (d.priceParticular || d.priceCartao)) {
      S.priceEntries.push({
        id: 'pe_' + Date.now() + '_' + d.id,
        doctorId: d.id, unitId: S.currentUnit,
        label: d.spec || d.defNature,
        priceParticular: d.priceParticular || null,
        priceCartao:     d.priceCartao     || null
      });
      autoSeeded = true;
    }
  });
  if (autoSeeded) saveConfig();

  const rows = doctors.map(d => {
    const entries = S.priceEntries.filter(e => e.doctorId === d.id && e.unitId === S.currentUnit);

    const docHeader = `<div style="font-weight:700;">${d.name}</div><div style="font-size:10px;color:var(--t3);font-style:italic;">${d.spec}</div>`;

    if (!entries.length) {
      return `<tr id="price-doc-${d.id}" style="border-bottom:2px solid var(--border);">
        <td style="padding:10px 12px;">${docHeader}</td>
        <td style="padding:10px 12px;color:var(--t3);font-size:11px;">—</td>
        <td style="padding:10px 12px;color:var(--t3);">—</td>
        <td style="padding:10px 12px;color:var(--t3);">—</td>
        <td style="padding:6px 12px;text-align:right;">
          ${canEdit ? `<button class="btn btn-primary" style="padding:5px 10px;font-size:10px;" onclick="addPriceEntry('${d.id}')">+ Serviço</button>` : ''}
        </td>
      </tr>`;
    }

    return entries.map((e, idx) => {
      const pp = e.priceParticular ? fmtPrice(e.priceParticular) : '—';
      const pc = e.priceCartao     ? fmtPrice(e.priceCartao)     : '—';
      const ppColor = e.priceParticular ? 'var(--active)' : 'var(--t3)';
      const pcColor = e.priceCartao     ? 'var(--active)' : 'var(--t3)';
      const isLast = idx === entries.length - 1;
      return `<tr id="price-entry-${e.id}" style="border-bottom:${isLast ? '2px solid var(--border)' : '1px solid rgba(255,255,255,0.05)'};">
        <td style="padding:${idx===0?'10px':'6px'} 12px;vertical-align:${idx===0?'top':'middle'};">
          ${idx===0 ? docHeader : '<span style="color:var(--t3);padding-left:6px;">└</span>'}
        </td>
        <td style="padding:8px 12px;">${e.label || '—'}</td>
        <td style="padding:8px 12px;font-weight:700;color:${ppColor};">${pp}</td>
        <td style="padding:8px 12px;font-weight:700;color:${pcColor};">${pc}</td>
        <td style="padding:6px 12px;text-align:right;white-space:nowrap;">
          ${canEdit ? `
            ${isLast ? `<button class="btn btn-primary" style="padding:4px 8px;font-size:10px;margin-right:2px;" onclick="addPriceEntry('${d.id}')">+</button>` : ''}
            <button class="btn btn-edit" style="padding:4px 8px;" onclick="editPriceEntry('${e.id}')">✎</button>
            <button class="btn btn-danger" style="padding:4px 8px;margin-left:2px;" onclick="deletePriceEntry('${e.id}')">✕</button>
          ` : ''}
        </td>
      </tr>`;
    }).join('');
  }).join('');

  el.innerHTML = `
  <div style="padding:20px;">
    <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:10px;">
      <h2 style="font-family:'Fraunces';font-size:18px;color:var(--accent);">Tabela de Preços</h2>
      <span style="font-size:11px;color:var(--t3);">${unit.name}</span>
    </div>
    <div style="margin-bottom:16px;">
      <input class="inp" id="priceSearchInp" type="text" value="${_priceSearch.replace(/"/g,'&quot;')}"
             placeholder="Buscar por profissional, especialidade, serviço ou valor..."
             oninput="_priceSearch=this.value; renderPriceTable();"
             style="width:100%;max-width:440px;padding:8px 12px;">
      ${q ? `<div style="margin-top:6px;font-size:11px;color:var(--t3);">${doctors.length} profissional${doctors.length!==1?'is':''} encontrado${doctors.length!==1?'s':''}</div>` : ''}
    </div>
    <div style="overflow-x:auto;border-radius:var(--r);border:1px solid var(--border);">
      <table class="dash-table" style="font-size:12px;width:100%;">
        <thead><tr>
          <th style="padding:10px 12px;min-width:180px;">Profissional</th>
          <th style="padding:10px 12px;">Serviço / Especialidade</th>
          <th style="padding:10px 12px;">Particular</th>
          <th style="padding:10px 12px;">Cartão Fisiocenter</th>
          <th style="padding:10px 12px;width:${canEdit?'160px':'10px'};"></th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="5" style="padding:20px;text-align:center;color:var(--t3);">Nenhum profissional cadastrado nesta unidade.</td></tr>`}</tbody>
      </table>
    </div>
    ${canEdit ? `<p style="margin-top:10px;font-size:10px;color:var(--t3);">Clique em <strong>+ Serviço</strong> para adicionar serviços por profissional. Use <strong>✎</strong> para editar e <strong>✕</strong> para remover.</p>` : ''}
  </div>`;

  if (_priceSearch) {
    const inp = document.getElementById('priceSearchInp');
    if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  }
}

function addPriceEntry(doctorId) {
  if (!S.priceEntries) S.priceEntries = [];
  const existing = document.getElementById('price-new-entry-form');
  if (existing) existing.remove();

  const d = S.doctors.find(doc => doc.id === doctorId);
  const isFirst = !S.priceEntries.some(e => e.doctorId === doctorId && e.unitId === S.currentUnit);
  const defLabel = isFirst && d ? (d.spec || '') : '';
  const defPP    = isFirst && d ? (d.priceParticular || '') : '';
  const defPC    = isFirst && d ? (d.priceCartao     || '') : '';

  const entries = S.priceEntries.filter(e => e.doctorId === doctorId && e.unitId === S.currentUnit);
  const anchor = entries.length
    ? document.getElementById(`price-entry-${entries[entries.length - 1].id}`)
    : document.getElementById(`price-doc-${doctorId}`);
  if (!anchor) return;

  const row = document.createElement('tr');
  row.id = 'price-new-entry-form';
  row.style.borderBottom = '2px solid var(--accent)';
  row.style.background = 'rgba(79,142,247,0.07)';
  row.innerHTML = `
    <td style="padding:8px 12px;color:var(--t3);font-size:11px;white-space:nowrap;">└ novo serviço</td>
    <td style="padding:6px 8px;"><input type="text" class="inp" id="new-pe-label" value="${defLabel.replace(/"/g,'&quot;')}" placeholder="Ex: Clínico Geral" style="padding:6px 8px;width:150px;"></td>
    <td style="padding:6px 8px;"><input type="text" class="inp" id="new-pe-pp" value="${defPP}" placeholder="R$" style="padding:6px 8px;width:90px;"></td>
    <td style="padding:6px 8px;"><input type="text" class="inp" id="new-pe-pc" value="${defPC}" placeholder="R$" style="padding:6px 8px;width:90px;"></td>
    <td style="padding:6px 8px;text-align:right;white-space:nowrap;">
      <button class="btn btn-ghost" style="padding:5px 8px;font-size:10px;" onclick="document.getElementById('price-new-entry-form').remove()">✕</button>
      <button class="btn btn-primary" style="padding:5px 10px;font-size:10px;margin-left:4px;" onclick="savePriceEntry('${doctorId}')">✓ Salvar</button>
    </td>`;
  anchor.after(row);
  setTimeout(() => { const inp = document.getElementById('new-pe-label'); if(inp){ inp.focus(); inp.select(); } }, 30);
}

function savePriceEntry(doctorId) {
  const label = document.getElementById('new-pe-label')?.value.trim();
  if (!label) { showToast('INFORME O SERVIÇO OU ESPECIALIDADE'); return; }
  if (!S.priceEntries) S.priceEntries = [];
  const pp = document.getElementById('new-pe-pp')?.value.trim();
  const pc = document.getElementById('new-pe-pc')?.value.trim();
  S.priceEntries.push({ id: 'pe_' + Date.now(), doctorId, unitId: S.currentUnit, label, priceParticular: pp || null, priceCartao: pc || null });
  saveConfig();
  showToast('SERVIÇO ADICIONADO!');
  renderPriceTable();
}

function editPriceEntry(entryId) {
  const e = (S.priceEntries || []).find(x => x.id === entryId);
  if (!e) return;
  const row = document.getElementById(`price-entry-${entryId}`);
  if (!row) return;
  row.style.background = 'rgba(79,142,247,0.07)';
  row.innerHTML = `
    <td style="padding:8px 12px;color:var(--t3);font-size:11px;">└</td>
    <td style="padding:6px 8px;"><input type="text" class="inp" id="edit-pe-label-${entryId}" value="${(e.label||'').replace(/"/g,'&quot;')}" placeholder="Serviço" style="padding:6px 8px;width:150px;"></td>
    <td style="padding:6px 8px;"><input type="text" class="inp" id="edit-pe-pp-${entryId}" value="${e.priceParticular||''}" placeholder="R$" style="padding:6px 8px;width:90px;"></td>
    <td style="padding:6px 8px;"><input type="text" class="inp" id="edit-pe-pc-${entryId}" value="${e.priceCartao||''}" placeholder="R$" style="padding:6px 8px;width:90px;"></td>
    <td style="padding:6px 8px;text-align:right;white-space:nowrap;">
      <button class="btn btn-ghost" style="padding:5px 8px;font-size:10px;" onclick="renderPriceTable()">✕</button>
      <button class="btn btn-primary" style="padding:5px 10px;font-size:10px;margin-left:4px;" onclick="updatePriceEntry('${entryId}')">✓ Salvar</button>
    </td>`;
  setTimeout(() => { const inp = document.getElementById(`edit-pe-label-${entryId}`); if(inp){ inp.focus(); inp.select(); } }, 30);
}

function updatePriceEntry(entryId) {
  const e = (S.priceEntries || []).find(x => x.id === entryId);
  if (!e) return;
  const label = document.getElementById(`edit-pe-label-${entryId}`)?.value.trim();
  if (!label) { showToast('INFORME O SERVIÇO OU ESPECIALIDADE'); return; }
  e.label = label;
  e.priceParticular = document.getElementById(`edit-pe-pp-${entryId}`)?.value.trim() || null;
  e.priceCartao     = document.getElementById(`edit-pe-pc-${entryId}`)?.value.trim() || null;
  saveConfig();
  showToast('ENTRADA ATUALIZADA!');
  renderPriceTable();
}

function deletePriceEntry(entryId) {
  if (!confirm('Remover esta entrada?')) return;
  S.priceEntries = (S.priceEntries || []).filter(x => x.id !== entryId);
  saveConfig();
  showToast('ENTRADA REMOVIDA!');
  renderPriceTable();
}

function showDoctorDetailsModal(doctorId) {
  const doctor = S.doctors.find(d => d.id === doctorId);
  if (!doctor) return;
  const existing = document.getElementById('doctorDetailsModal');
  if (existing) existing.remove();
  const html = `
  <div class="modal-overlay open" id="doctorDetailsModal" onclick="closeDoctorDetailsModal()">
    <div class="modal-card" onclick="event.stopPropagation()" style="max-width:560px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
        <h2 style="font-family:'Fraunces';font-size:18px;color:var(--accent);margin:0;">${doctor.name}</h2>
        <button class="btn" style="padding:5px 10px" onclick="closeDoctorDetailsModal()">✕</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;padding:12px;background:var(--s2);border-radius:var(--r);border:1px solid var(--border);">
        <div><div style="font-size:9px;color:var(--t3);font-weight:800;text-transform:uppercase;margin-bottom:4px;">Especialidade</div><div style="font-weight:700;">${doctor.spec}</div></div>
        <div><div style="font-size:9px;color:var(--t3);font-weight:800;text-transform:uppercase;margin-bottom:4px;">Atendimento</div><div style="font-weight:700;">${doctor.type === 'hora' ? 'Hora Marcada' : 'Ordem de Chegada'}</div></div>
      </div>
      <div style="margin-bottom:16px;">
        <div style="font-size:9px;font-weight:900;color:var(--t3);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Convênios</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;">
          ${(doctor.convenios||[]).map(c=>`<span style="background:rgba(79,142,247,0.1);border:1px solid var(--accent);color:var(--accent);padding:4px 10px;border-radius:4px;font-size:10px;font-weight:700;">${c.nome}</span>`).join('')||'<span style="color:var(--t3);font-size:10px;">Nenhum</span>'}
        </div>
      </div>
      ${(doctor.convenios||[]).some(c=>(c.procedimentos||[]).length)? `
      <div>
        <div style="font-size:9px;font-weight:900;color:var(--t3);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Tabela de Valores</div>
        <table class="dash-table" style="font-size:10px;">
          <thead><tr><th>Procedimento</th><th style="text-align:right;">Valor</th></tr></thead>
          <tbody>
            ${(doctor.convenios||[]).flatMap(conv=>(conv.procedimentos||[]).map(p=>`
              <tr><td>${p.nome}<div style="font-size:9px;color:var(--t2);">${conv.nome}</div></td>
              <td style="text-align:right;color:var(--active);font-weight:700;">R$ ${parseFloat(p.valor||0).toFixed(2).replace('.',',')}</td></tr>`)).join('')}
          </tbody>
        </table>
      </div>` : ''}
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

function closeDoctorDetailsModal() {
  document.getElementById('doctorDetailsModal')?.remove();
}

// ───────────────────────────────────────────────────────────────────────────

async function init() {
    // 1. Carregar estado de UI do localStorage
    const uiState = localStorage.getItem('mds_ui_state');
    if (uiState) {
        try {
            const p = JSON.parse(uiState);
            S.currentUnit = p.currentUnit || S.currentUnit;
            S.view        = p.view        || S.view;
            // weekAnchor e mês NÃO são restaurados — sempre abre no dia atual
            S.theme       = p.theme;
        } catch(e) {}
    }

    // 2. Carregar configurações do Supabase
    try {
        const { data: configRows, error: cfgErr } = await _supabase.from('mapa_config').select('*');
        if (!cfgErr && configRows && configRows.length > 0) {
            const unitsRow        = configRows.find(r => r.id === 'units');
            const doctorsRow      = configRows.find(r => r.id === 'doctors');
            const priceEntriesRow = configRows.find(r => r.id === 'priceEntries');
            if (unitsRow?.data)        S.units        = unitsRow.data;
            if (doctorsRow?.data)      S.doctors      = doctorsRow.data;
            if (priceEntriesRow?.data) S.priceEntries = priceEntriesRow.data;
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

    // Sempre abre na semana atual
    const now = new Date();
    S.weekAnchor = fmt(monday(now));
    S.monthYear  = now.getFullYear();
    S.monthMonth = now.getMonth();

    renderUnitSelect();
    renderNavLabel();
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
  if(S.view === 'dashboard') return;
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
    if (isMassMode && v !== 'month') toggleMassMode();
    if (v !== 'priceTable') _priceSearch = '';
    S.view = v;
    ['btnWeek','btnMonth','btnDash','btnPriceTable'].forEach(id => { const b=document.getElementById(id); if(b) b.classList.remove('active'); });
    const activeId = v==='week'?'btnWeek':v==='month'?'btnMonth':v==='priceTable'?'btnPriceTable':'btnDash';
    const ab = document.getElementById(activeId); if(ab) ab.classList.add('active');
    const navGroup = document.getElementById('navGroup');
    if(navGroup) navGroup.style.display = (v==='dashboard' || v==='priceTable') ? 'none' : '';
    renderNavLabel(); renderMain(); saveLocal();
}

// RENDERIZAÇÃO
function renderMain() {
  if (S.view === 'dashboard')  { renderDashboard();  return; }
  if (S.view === 'priceTable') { renderPriceTable(); return; }
  const el = document.getElementById('mainContent');
  const unit = S.units.find(u => u.id === S.currentUnit);
  if(!unit) { el.innerHTML = "Unidade não encontrada."; return; }

  // Função auxiliar: sala visível para uma data específica?
  function roomVisibleOnDate(r, dateStr) {
      if (r.archived) return false;
      if (r.archivedFrom && dateStr >= r.archivedFrom) return false;
      return true;
  }

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

    const isDiaSuS = !!S.slots[`${unit.id}|diasuS|${date}|dia`];
    const dayCardStyle = isToday ? 'border:2px solid var(--accent)' : '';
    h += `
    <div class="day-card${isPrevMonth ? ' day-card--prev-month' : ''}${isDiaSuS ? ' diasuS' : ''}" style="${dayCardStyle}">
      <div class="day-header">${dayName} ${dt.getDate()}/${dt.getMonth()+1}</div>
      <table class="day-table">
        <thead>
          <tr>
            <th style="width:50px"></th>
            ${unit.rooms.filter(r => roomVisibleOnDate(r, date)).map((r,i) => `<th class="room-th room-color-${i%5}">${r.name}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${['manha', 'tarde'].map(p => `
            <tr>
              <td class="side-label">${p === 'manha' ? 'MANHÃ' : 'TARDE'}</td>
              ${unit.rooms.filter(r => roomVisibleOnDate(r, date)).map(r => {
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
  if(slot.status === 'manutencao') {
      return `
      <div class="mini-slot manutencao" title="EM MANUTENÇÃO" draggable="${draggableAttr}" ondragstart="handleDragStart(event, '${key}')">
          ${isMonthView
              ? '<span style="font-size:11px;">⚠️</span>'
              : '<span style="font-size:28px;line-height:1;">⚠️</span><span style="font-size:7px;font-weight:900;letter-spacing:0.5px;margin-top:2px;">MANUTENÇÃO</span>'
          }
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
      if (natureTxt === 'Consulta/Sessão') tags.push(`<span class="mtag mtag-nature">CONSULTA/SESSÃO</span>`);
      if (typeTxt === 'hora') tags.push(`<span class="mtag mtag-type">HORA MARCADA</span>`);
  }

  const typeDisplay = typeTxt === 'hora' ? 'Hora Marcada' : 'Ordem de Chegada';
  let tooltip = `${doc.name}\nEspecialidade: ${doc.spec}\nNatureza: ${natureTxt}\nAtendimento: ${typeDisplay}`;

  if ((natureTxt === 'Consulta' || natureTxt === 'Consulta/Sessão') && (doc.priceParticular || doc.priceCartao)) {
      if (doc.priceParticular) tooltip += `\nParticular: ${fmtPrice(doc.priceParticular)}`;
      if (doc.priceCartao) tooltip += `\nCartão Fisiocenter: ${fmtPrice(doc.priceCartao)}`;
  }

  let obsWarning = '';
  if (slot.obs) {
      obsWarning = `<span class="obs-icon">⚠️</span>`;
      tooltip += `\nObservação: ${slot.obs}`;
  }

  const safeTooltip = tooltip.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');

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
    <div class="mini-slot ${slot.status}" onclick="handleSlotClick(event,'${key}')" draggable="${draggableAttr}" ondragstart="handleDragStart(event, '${key}')">
        ${obsWarning}
        <span class="doc-name-tip" data-tip="${safeTooltip}" onclick="handleNameTipClick(event,'${key}')">${nameHTML}</span>
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

    // Bloqueia novas alocações em sala arquivada para esta data
    const roomObj = unit?.rooms.find(r => r.id === parts[1]);
    const roomBlocked = roomObj && (roomObj.archived || (roomObj.archivedFrom && date >= roomObj.archivedFrom));
    if (roomBlocked && !S.slots[key]) { showToast("SALA ARQUIVADA — SEM NOVAS ALOCAÇÕES"); return; }

    const massDoc = S.doctors.find(d => d.id === massDocId);
    const effectiveNature = (massDoc && massDoc.defaultNature) ? massDoc.defaultNature : massNature;
    const needsDoctor = massStatus !== 'feriado' && massStatus !== 'manutencao';

    function buildSlot(k) {
        if (massStatus === 'feriado')    return { status: 'feriado',    doctorId: null };
        if (massStatus === 'manutencao') return { status: 'manutencao', doctorId: null };
        return { doctorId: massDocId, status: massStatus, nature: effectiveNature, obs: '' };
    }

    if (massDiaInteiro) {
        const allKeys = [];
        if (massStatus === 'feriado') {
            // Feriado: todas as salas visíveis nesta data
            unit.rooms.filter(r => !r.archived && (!r.archivedFrom || date < r.archivedFrom)).forEach(r => {
                allKeys.push(`${unitId}|${r.id}|${date}|manha`);
                allKeys.push(`${unitId}|${r.id}|${date}|tarde`);
            });
        } else {
            // Médico / Manutenção / Cancelado: apenas a sala clicada, manhã + tarde
            const roomId = parts[1];
            allKeys.push(`${unitId}|${roomId}|${date}|manha`);
            allKeys.push(`${unitId}|${roomId}|${date}|tarde`);
        }

        const anyFilled = allKeys.some(k => S.slots[k]);

        if (anyFilled) {
            allKeys.forEach(k => { delete S.slots[k]; });
            removeSlots(allKeys);
        } else {
            if (needsDoctor && !massDocId) { showToast("SELECIONE O MÉDICO NO MENU SUPERIOR!"); return; }
            const toAdd = {};
            allKeys.forEach(k => { S.slots[k] = buildSlot(k); toAdd[k] = S.slots[k]; });
            upsertSlots(toAdd);
        }
    } else {
        const existing = S.slots[key];
        if (existing) {
            delete S.slots[key];
            removeSlot(key);
        } else {
            if (needsDoctor && !massDocId) { showToast("SELECIONE O MÉDICO NO MENU SUPERIOR!"); return; }
            S.slots[key] = buildSlot(key);
            upsertSlot(key, S.slots[key]);
        }
    }

    renderMain();
}

// ALOCAÇÃO SIMPLES (MODAL) E EXCLUSÃO
function openAlloc(key) {
  if(!isEditActive(S.currentUnit)) { openLock(); return; }

  if(isMassMode) { applyMassClickToSlot(key); return; }

  // Bloqueia novas alocações em salas arquivadas (mas permite editar slots existentes)
  const slot = S.slots[key];
  const parts0 = key.split('|');
  const date0 = parts0[2];
  const unitObj = S.units.find(u => u.id === parts0[0]);
  const roomObj = unitObj?.rooms.find(r => r.id === parts0[1]);
  const roomBlocked = roomObj && (roomObj.archived || (roomObj.archivedFrom && date0 >= roomObj.archivedFrom));
  if (roomBlocked && !slot) { showToast("SALA ARQUIVADA — SEM NOVAS ALOCAÇÕES"); return; }
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

  const diasuSKey = `${parts0[0]}|diasuS|${date0}|dia`;
  document.getElementById('btnDelAlloc').style.display = (slot || !!S.slots[diasuSKey]) ? 'block' : 'none';

  const st = S.slots[diasuSKey] ? 'diasuS' : (slot ? slot.status : 'active');
  const nt = slot ? (slot.nature || 'Consulta') : 'Consulta';

  setTgl('tglAllocStatus', document.querySelector(`#tglAllocStatus .tgl-btn[onclick*="'${st}'"]`), st);
  setTgl('tglAllocNature', document.querySelector(`#tglAllocNature .tgl-btn[onclick*="'${nt}'"]`), nt);
  setTgl('tglAllocScope', document.querySelector(`#tglAllocScope .tgl-btn[onclick*="'periodo'"]`), 'periodo');

  document.getElementById('allocObs').value = slot?.obs || '';
}

function closeAlloc() { document.getElementById('allocModal').classList.remove('open'); }

// BUSCA DE MÉDICO
let searchSelectedDocId = null;
let searchFromMonth = '';

function openSearch() {
    searchSelectedDocId = null;
    searchFromMonth = new Date().toISOString().slice(0, 7);
    document.getElementById('searchPanel').classList.add('open');
    document.getElementById('searchInp').value = '';
    filterDoctors('');
    setTimeout(() => document.getElementById('searchInp').focus(), 100);
}

function closeSearch() {
    document.getElementById('searchPanel').classList.remove('open');
}

function filterDoctors(query) {
    const unitDocs = S.doctors.filter(d => d.unitId === S.currentUnit && !d.archived);
    const q = query.trim().toLowerCase();
    const body = document.getElementById('searchBody');

    if (!q && !searchSelectedDocId) {
        body.innerHTML = `<div style="color:var(--t3);font-size:11px;padding:24px;text-align:center;">Digite para buscar por nome ou especialidade.</div>`;
        return;
    }

    const filtered = q
        ? unitDocs.filter(d => d.name.toLowerCase().includes(q) || (d.spec || '').toLowerCase().includes(q))
        : (searchSelectedDocId ? unitDocs.filter(d => d.id === searchSelectedDocId) : []);

    const sorted = [...filtered].sort((a, b) => {
        const nA = a.name.replace(/^(Dr\.|Dra\.)\s+/i, '').trim();
        const nB = b.name.replace(/^(Dr\.|Dra\.)\s+/i, '').trim();
        return nA.localeCompare(nB);
    });

    if (!sorted.length) {
        body.innerHTML = `<div style="color:var(--t3);font-size:11px;padding:24px;text-align:center;">Nenhum profissional encontrado.</div>`;
        return;
    }

    const hasSelection = searchSelectedDocId && sorted.find(d => d.id === searchSelectedDocId);
    const hint = !hasSelection && sorted.length > 1
        ? `<div style="font-size:10px;color:var(--t3);padding:6px 12px 2px;">Clique em um profissional para ver só a agenda dele.</div>`
        : (hasSelection ? `<div style="font-size:10px;color:var(--t3);padding:6px 12px 2px;">Clique novamente para ver todos.</div>` : '');

    let html = hint + `<div>`;
    sorted.forEach(doc => {
        const sel = doc.id === searchSelectedDocId;
        html += `
        <div class="search-doc-item${sel ? ' selected' : ''}" onclick="selectDoctor('${doc.id}')">
            <div style="font-weight:700;font-size:12px;color:var(--text);">${doc.name}</div>
            <div style="font-size:10px;color:var(--t2);margin-top:2px;">${doc.spec || ''}</div>
        </div>`;
    });
    html += `</div>`;

    if (hasSelection) {
        html += renderDoctorSchedule(searchSelectedDocId);
    } else {
        html += renderMultiDoctorSchedule(sorted.map(d => d.id));
    }

    body.innerHTML = html;
}

function selectDoctor(docId) {
    searchSelectedDocId = (searchSelectedDocId === docId) ? null : docId;
    filterDoctors(document.getElementById('searchInp').value);
}

function renderMultiDoctorSchedule(docIds) {
    const allEntries = Object.entries(S.slots).filter(([key, slot]) => {
        const p = key.split('|');
        return p[0] === S.currentUnit && docIds.includes(slot.doctorId);
    });

    const entries = allEntries.filter(([key]) => key.split('|')[2].slice(0, 7) >= searchFromMonth);

    entries.sort(([kA], [kB]) => {
        const pA = kA.split('|'), pB = kB.split('|');
        const dc = pA[2].localeCompare(pB[2]);
        return dc !== 0 ? dc : (pA[3] === 'manha' ? -1 : 1);
    });

    const byMonth = {};
    entries.forEach(([key, slot]) => {
        const p = key.split('|');
        const date = p[2], period = p[3], monthKey = date.slice(0, 7);
        if (!byMonth[monthKey]) byMonth[monthKey] = [];
        const unit = S.units.find(u => u.id === S.currentUnit);
        const room = unit?.rooms.find(r => r.id === p[1]);
        const doc  = S.doctors.find(d => d.id === slot.doctorId);
        byMonth[monthKey].push({ slot, date, period, room, doc });
    });

    const specLabel = docIds.length === 1
        ? (S.doctors.find(d => d.id === docIds[0])?.spec || '')
        : (S.doctors.find(d => d.id === docIds[0])?.spec || `${docIds.length} profissionais`);

    let html = `<div style="border-top:1px solid var(--border);padding-top:14px;">
        <div style="font-size:9px;font-weight:900;color:var(--t3);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">Agenda — ${specLabel}</div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;padding:8px 10px;background:var(--s3);border-radius:var(--r);border:1px solid var(--border);">
            <span style="font-size:9px;font-weight:800;color:var(--t3);text-transform:uppercase;white-space:nowrap;">A partir de:</span>
            <input type="month" value="${searchFromMonth}"
                   style="background:var(--s4);border:1px solid var(--border);border-radius:4px;padding:3px 6px;color:var(--text);font-size:11px;flex:1;font-family:inherit;outline:none;"
                   onchange="searchFromMonth=this.value; filterDoctors(document.getElementById('searchInp').value)">
        </div>`;

    if (!entries.length) {
        html += `<div style="color:var(--t3);font-size:11px;padding:12px;text-align:center;">Nenhum atendimento no período selecionado.</div>`;
    } else {
        Object.entries(byMonth).sort(([a],[b]) => a.localeCompare(b)).forEach(([monthKey, items]) => {
            const [yr, mo] = monthKey.split('-');
            html += `<div style="font-size:9px;font-weight:900;color:var(--accent);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid var(--border);">${MONTHS_PT[+mo-1]} ${yr}</div>`;
            items.forEach(({ slot, date, period, room, doc }) => {
                const dt = parse(date);
                const dayName = DAYS_PT[dt.getDay()];
                const dayNum = `${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}/${dt.getFullYear()}`;
                const periodLabel = period === 'manha' ? 'Manhã' : 'Tarde';
                const statusLabel = slot.status === 'canceled' ? 'Cancelado' : 'Ativo';
                const statusColor = slot.status === 'canceled' ? 'var(--cancel)' : 'var(--active)';
                const natLabel = slot.nature || (doc && doc.defNature) || 'Consulta';
                const roomName = room ? room.name : '—';
                html += `
                <div class="search-sched-item ${slot.status}" onclick="navigateToDate('${date}')">
                    <div style="font-weight:700;font-size:11px;color:var(--text);">${dayName}, ${dayNum}</div>
                    <div style="font-size:10px;color:var(--accent);margin-top:1px;">${doc ? doc.name : '—'}</div>
                    <div style="display:flex;gap:6px;margin-top:3px;align-items:center;flex-wrap:wrap;">
                        <span style="font-size:9px;color:var(--t2);">${periodLabel}</span>
                        <span style="font-size:8px;color:var(--t3);">·</span>
                        <span style="font-size:9px;color:var(--t2);">${roomName}</span>
                        <span style="font-size:8px;color:var(--t3);">·</span>
                        <span style="font-size:9px;font-weight:700;color:${statusColor};">${statusLabel}</span>
                        <span style="font-size:8px;color:var(--t3);">·</span>
                        <span style="font-size:9px;color:var(--t2);">${natLabel}</span>
                    </div>
                </div>`;
            });
            html += `<div style="margin-bottom:10px;"></div>`;
        });
    }

    html += `</div>`;
    return html;
}

function renderDoctorSchedule(docId) {
    const doc = S.doctors.find(d => d.id === docId);
    if (!doc) return '';

    const allEntries = Object.entries(S.slots).filter(([key, slot]) => {
        const p = key.split('|');
        return p[0] === S.currentUnit && slot.doctorId === docId;
    });

    const entries = allEntries.filter(([key]) => key.split('|')[2].slice(0, 7) >= searchFromMonth);

    entries.sort(([kA], [kB]) => {
        const pA = kA.split('|'), pB = kB.split('|');
        const dc = pA[2].localeCompare(pB[2]);
        return dc !== 0 ? dc : (pA[3] === 'manha' ? -1 : 1);
    });

    const byMonth = {};
    entries.forEach(([key, slot]) => {
        const p = key.split('|');
        const date = p[2], period = p[3], monthKey = date.slice(0, 7);
        if (!byMonth[monthKey]) byMonth[monthKey] = [];
        const unit = S.units.find(u => u.id === S.currentUnit);
        const room = unit?.rooms.find(r => r.id === p[1]);
        byMonth[monthKey].push({ slot, date, period, room });
    });

    let html = `<div style="border-top:1px solid var(--border);padding-top:14px;">
        <div style="font-size:9px;font-weight:900;color:var(--t3);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">Agenda — ${doc.name}</div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;padding:8px 10px;background:var(--s3);border-radius:var(--r);border:1px solid var(--border);">
            <span style="font-size:9px;font-weight:800;color:var(--t3);text-transform:uppercase;white-space:nowrap;">A partir de:</span>
            <input type="month" value="${searchFromMonth}"
                   style="background:var(--s4);border:1px solid var(--border);border-radius:4px;padding:3px 6px;color:var(--text);font-size:11px;flex:1;font-family:inherit;outline:none;"
                   onchange="searchFromMonth=this.value; filterDoctors(document.getElementById('searchInp').value)">
        </div>`;

    if (!entries.length) {
        html += `<div style="color:var(--t3);font-size:11px;padding:12px;text-align:center;">Nenhum atendimento no período selecionado.</div>`;
    } else {
        Object.entries(byMonth).sort(([a],[b]) => a.localeCompare(b)).forEach(([monthKey, items]) => {
            const [yr, mo] = monthKey.split('-');
            html += `<div style="font-size:9px;font-weight:900;color:var(--accent);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid var(--border);">${MONTHS_PT[+mo-1]} ${yr}</div>`;

            items.forEach(({ slot, date, period, room }) => {
                const dt = parse(date);
                const dayName = DAYS_PT[dt.getDay()];
                const dayNum = `${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}/${dt.getFullYear()}`;
                const periodLabel = period === 'manha' ? 'Manhã' : 'Tarde';
                const statusLabel = slot.status === 'canceled' ? 'Cancelado' : 'Ativo';
                const statusColor = slot.status === 'canceled' ? 'var(--cancel)' : 'var(--active)';
                const natLabel = slot.nature || doc.nature || 'Consulta';
                const roomName = room ? room.name : '—';

                html += `
                <div class="search-sched-item ${slot.status}" onclick="navigateToDate('${date}')">
                    <div style="font-weight:700;font-size:11px;color:var(--text);">${dayName}, ${dayNum}</div>
                    <div style="display:flex;gap:6px;margin-top:3px;align-items:center;flex-wrap:wrap;">
                        <span style="font-size:9px;color:var(--t2);">${periodLabel}</span>
                        <span style="font-size:8px;color:var(--t3);">·</span>
                        <span style="font-size:9px;color:var(--t2);">${roomName}</span>
                        <span style="font-size:8px;color:var(--t3);">·</span>
                        <span style="font-size:9px;font-weight:700;color:${statusColor};">${statusLabel}</span>
                        <span style="font-size:8px;color:var(--t3);">·</span>
                        <span style="font-size:9px;color:var(--t2);">${natLabel}</span>
                    </div>
                </div>`;
            });
            html += `<div style="margin-bottom:10px;"></div>`;
        });
    }

    html += `</div>`;
    return html;
}

function navigateToDate(date) {
    closeSearch();
    S.weekAnchor = fmt(monday(parse(date)));
    setView('week');
}

function saveAllocation() {
  const key    = document.getElementById('allocKey').value;
  const docId  = document.getElementById('allocDocId').value;
  const status = curTgl.tglAllocStatus;
  const scope  = curTgl.tglAllocScope;
  const obs    = document.getElementById('allocObs').value.trim();
  const doc    = S.doctors.find(d => d.id === docId);
  const nature = (doc && doc.defaultNature) ? doc.defaultNature : curTgl.tglAllocNature;

  const noDocNeeded = status === 'feriado' || status === 'manutencao' || status === 'diasuS';
  if(!docId && !noDocNeeded) { showToast("SELECIONE UM MÉDICO!"); return; }

  const unit  = S.units.find(u => u.id === S.currentUnit);
  const parts = key.split('|');
  const date  = parts[2];
  const period = parts[3];

  const toSave = {};

  if (status === 'feriado') {
      unit.rooms.filter(r => !r.archived && (!r.archivedFrom || date < r.archivedFrom)).forEach(room => {
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
  } else if (status === 'manutencao') {
      const applyM = (k) => {
          S.slots[k] = { status: 'manutencao', doctorId: null };
          toSave[k] = S.slots[k];
      };
      applyM(key);
      if(scope === 'diatodo') {
          applyM(`${parts[0]}|${parts[1]}|${parts[2]}|${period === 'manha' ? 'tarde' : 'manha'}`);
      }
      showToast(scope === 'diatodo' ? "DIA TODO MARCADO COMO MANUTENÇÃO" : "TURNO MARCADO COMO MANUTENÇÃO");
  } else if (status === 'diasuS') {
      const diasuSKey = `${parts[0]}|diasuS|${date}|dia`;
      S.slots[diasuSKey] = { status: 'diasuS', doctorId: null };
      toSave[diasuSKey] = S.slots[diasuSKey];
      showToast("DIA MARCADO COMO DIA DE SUS");
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
        unit.rooms.filter(r => !r.archived && (!r.archivedFrom || date < r.archivedFrom)).forEach(r => {
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

    const diasuSDelKey = `${unitId}|diasuS|${date}|dia`;
    if (S.slots[diasuSDelKey]) {
        delete S.slots[diasuSDelKey];
        keysToDelete.push(diasuSDelKey);
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
                isAdminActive = true;
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
    isAdminActive = false;
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
    switchCfgTab(isAdminActive ? 'unidade' : 'salas');
}
function closeConfig(){
    document.getElementById('cfgPanel').classList.remove('open');
    renderMain();
}

function switchCfgTab(tab) {
  // A aba de unidades só fica visível para ADM
  const tabUnEl = document.getElementById('tabUnidade');
  if (tabUnEl) tabUnEl.style.display = isAdminActive ? '' : 'none';

  document.querySelectorAll('.cfg-tab').forEach(t => t.classList.remove('active'));
  const targetTab = document.getElementById('tab'+tab.charAt(0).toUpperCase()+tab.slice(1));
  if (targetTab) targetTab.classList.add('active');
  renderCfgBody(tab);
}

function renderCfgBody(tab) {
    const body = document.getElementById('cfgBody');
    const unit = S.units.find(u => u.id === S.currentUnit);

    if(tab === 'unidade') {
        const activeUnits   = S.units.filter(u => !u.archived);
        const archivedUnits = S.units.filter(u => u.archived);
        body.innerHTML = `
            <div class="form-group"><label class="form-label">Cadastrar Nova Unidade</label>
            <div style="display:flex;gap:5px"><input class="inp" type="text" id="newUnitInp" placeholder="NOME DA UNIDADE..."><button class="btn btn-primary" onclick="addUnit()">+</button></div></div>
            <div style="margin-top:20px">${activeUnits.map(u => `
                <div class="cfg-row" id="row-u-${u.id}">
                    <span id="txt-u-${u.id}">${u.name}</span>
                    <div class="cfg-row-actions">
                        <button class="btn btn-edit" onclick="editUnit('${u.id}')">✎</button>
                        <button class="btn btn-archive" onclick="archiveUnit('${u.id}')" title="Arquivar unidade">⊘</button>
                        <button class="btn btn-danger" style="padding:5px 10px" onclick="deleteUnit('${u.id}')">✕</button>
                    </div>
                </div>`).join('')}</div>
            ${archivedUnits.length > 0 ? `
            <div style="margin-top:24px; border-top:1px solid var(--border); padding-top:12px;">
                <div style="font-size:9px; font-weight:900; text-transform:uppercase; color:var(--t3); letter-spacing:1px; margin-bottom:10px;">
                    Arquivadas (${archivedUnits.length})
                </div>
                ${archivedUnits.map(u => `
                <div class="cfg-row" id="row-u-${u.id}" style="opacity:0.55;">
                    <span>${u.name}</span>
                    <div class="cfg-row-actions">
                        <button class="btn btn-primary" style="padding:5px 8px; font-size:9px;" onclick="unarchiveUnit('${u.id}')">REATIVAR</button>
                        <button class="btn btn-danger" style="padding:5px 10px" onclick="deleteUnit('${u.id}')">✕</button>
                    </div>
                </div>`).join('')}
            </div>` : ''}
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
                    <div id="tglDefaultNature" style="display:flex;flex-direction:column;gap:6px;">
                        <div style="display:flex;gap:6px;">
                            <button class="tgl-btn active" style="flex:1" onclick="setTglWithPrices('tglDefaultNature',this,'','newDocPrices')">Nenhuma</button>
                            <button class="tgl-btn" style="flex:1" onclick="setTglWithPrices('tglDefaultNature',this,'Consulta','newDocPrices')">Consulta</button>
                        </div>
                        <div style="display:flex;gap:6px;">
                            <button class="tgl-btn" style="flex:1" onclick="setTglWithPrices('tglDefaultNature',this,'Consulta/Sessão','newDocPrices')">Consulta/Sessão</button>
                            <button class="tgl-btn" style="flex:1" onclick="setTglWithPrices('tglDefaultNature',this,'Procedimento','newDocPrices')">Procedimento</button>
                        </div>
                    </div>
                </div>
                <div id="newDocPrices" style="display:none; background:var(--s1); border:1px solid var(--border); border-radius:4px; padding:10px; margin-top:-8px; margin-bottom:8px;">
                    <label class="form-label" style="margin-bottom:8px;">Valores de Consulta</label>
                    <div style="display:flex; gap:8px;">
                        <div style="flex:1;">
                            <label style="font-size:9px;color:var(--t3);font-weight:800;display:block;margin-bottom:4px;">PARTICULAR (R$)</label>
                            <input type="text" class="inp" id="newDocPriceParticular" placeholder="0,00" style="padding:6px 8px;">
                        </div>
                        <div style="flex:1;">
                            <label style="font-size:9px;color:var(--t3);font-weight:800;display:block;margin-bottom:4px;">CARTÃO FISIOCENTER (R$)</label>
                            <input type="text" class="inp" id="newDocPriceCartao" placeholder="0,00" style="padding:6px 8px;">
                        </div>
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
        const activeRooms   = unit.rooms.filter(r => !r.archived && !r.archivedFrom);
        const archivedRooms = unit.rooms.filter(r => r.archived || r.archivedFrom);
        body.innerHTML = `
            <div class="form-group"><label class="form-label">Adicionar Sala em: <strong style="color:var(--accent); text-transform:uppercase;">${unit.name}</strong></label>
            <div style="display:flex;gap:5px"><input class="inp" type="text" id="newRoomInp" placeholder="Ex: SALA 6"><button class="btn btn-primary" onclick="addRoom()">+</button></div></div>
            <div style="margin-top:20px">${activeRooms.map(r => `
                <div class="cfg-row" id="row-r-${r.id}">
                    <span id="txt-r-${r.id}">${r.name}</span>
                    <div class="cfg-row-actions">
                        <button class="btn btn-edit" onclick="editRoom('${r.id}')">✎</button>
                        <button class="btn btn-archive" onclick="archiveRoom('${r.id}')" title="Arquivar sala a partir de uma data">⊘</button>
                        <button class="btn btn-danger" style="padding:5px 10px" onclick="deleteRoom('${r.id}')">✕</button>
                    </div>
                </div>`).join('')}</div>
            ${archivedRooms.length > 0 ? `
            <div style="margin-top:24px; border-top:1px solid var(--border); padding-top:12px;">
                <div style="font-size:9px; font-weight:900; text-transform:uppercase; color:var(--t3); letter-spacing:1px; margin-bottom:10px;">
                    Arquivadas (${archivedRooms.length})
                </div>
                ${archivedRooms.map(r => `
                <div class="cfg-row" id="row-r-${r.id}" style="opacity:0.55;">
                    <div style="display:flex;flex-direction:column;">
                        <span>${r.name}</span>
                        ${r.archivedFrom ? `<span style="font-size:9px;color:var(--t3);">a partir de ${r.archivedFrom}</span>` : ''}
                    </div>
                    <div class="cfg-row-actions">
                        <button class="btn btn-primary" style="padding:5px 8px; font-size:9px;" onclick="unarchiveRoom('${r.id}')">REATIVAR</button>
                        <button class="btn btn-danger" style="padding:5px 10px" onclick="deleteRoom('${r.id}')">✕</button>
                    </div>
                </div>`).join('')}
            </div>` : ''}
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

function setTglWithPrices(groupId, btn, val, priceGroupId) {
    setTgl(groupId, btn, val);
    const pg = document.getElementById(priceGroupId);
    if (pg) pg.style.display = (val === 'Consulta' || val === 'Consulta/Sessão') ? '' : 'none';
}

function setEditTglWithPrices(gid, btn, priceGroupId) {
    setEditTgl(gid, btn);
    const val = btn.getAttribute('data-val');
    const pg = document.getElementById(priceGroupId);
    if (pg) pg.style.display = (val === 'Consulta' || val === 'Consulta/Sessão') ? '' : 'none';
}

function editDoctor(id) {
    const d = S.doctors.find(x => x.id === id);
    const row = document.getElementById(`row-d-${id}`);

    let prefix = d.name.startsWith('Dra.') ? 'Dra.' : 'Dr.';
    let cleanName = d.name.replace('Dr. ', '').replace('Dra. ', '');
    let type = d.type || 'hora';
    let defNature = d.defaultNature || '';
    const docConvenios = d.convenios || [];
    const docProcs = d.procedimentos || [];

    const convenios = getFilteredConvenios();
    const procedimentos = getAvailableProcedimentos();

    const convHtml = convenios.length > 0 ? `
        <label style="font-size:9px;color:var(--t3);font-weight:800;text-transform:uppercase;margin-top:4px;">Convênios Atendidos</label>
        <div style="display:flex;flex-direction:column;gap:4px;background:var(--s1);padding:8px;border-radius:4px;border:1px solid var(--border);">
            ${convenios.map(c => `
                <label style="display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer;">
                    <input type="checkbox" data-conv-id="${c.Id}" ${docConvenios.includes(String(c.Id)) ? 'checked' : ''}>
                    ${c.Nome || c.Descricao || c.id}
                </label>`).join('')}
        </div>` : '';

    const procHtml = procedimentos.length > 0 ? `
        <label style="font-size:9px;color:var(--t3);font-weight:800;text-transform:uppercase;margin-top:4px;">Procedimentos Realizados</label>
        <div style="display:flex;flex-direction:column;gap:4px;background:var(--s1);padding:8px;border-radius:4px;border:1px solid var(--border);max-height:150px;overflow-y:auto;">
            ${procedimentos.map(p => `
                <label style="display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer;">
                    <input type="checkbox" data-proc-id="${p.Id}" ${docProcs.includes(String(p.Id)) ? 'checked' : ''}>
                    ${p.Nome || p.Descricao || p.id}
                </label>`).join('')}
        </div>` : '';

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
            <div id="edit-tglDefNature-${id}" style="display:flex;flex-direction:column;gap:6px;">
                <div style="display:flex;gap:6px;">
                    <button class="tgl-btn ${defNature === '' ? 'active' : ''}" style="flex:1" data-val="" onclick="setEditTglWithPrices('edit-tglDefNature-${id}', this, 'edit-prices-${id}')">Nenhuma</button>
                    <button class="tgl-btn ${defNature === 'Consulta' ? 'active' : ''}" style="flex:1" data-val="Consulta" onclick="setEditTglWithPrices('edit-tglDefNature-${id}', this, 'edit-prices-${id}')">Consulta</button>
                </div>
                <div style="display:flex;gap:6px;">
                    <button class="tgl-btn ${defNature === 'Consulta/Sessão' ? 'active' : ''}" style="flex:1" data-val="Consulta/Sessão" onclick="setEditTglWithPrices('edit-tglDefNature-${id}', this, 'edit-prices-${id}')">Consulta/Sessão</button>
                    <button class="tgl-btn ${defNature === 'Procedimento' ? 'active' : ''}" style="flex:1" data-val="Procedimento" onclick="setEditTglWithPrices('edit-tglDefNature-${id}', this, 'edit-prices-${id}')">Procedimento</button>
                </div>
            </div>
            <div id="edit-prices-${id}" style="display:${(defNature === 'Consulta' || defNature === 'Consulta/Sessão') ? '' : 'none'}; background:var(--s1); border:1px solid var(--border); border-radius:4px; padding:10px; margin-top:4px;">
                <label class="form-label" style="margin-bottom:8px; font-size:9px;">VALORES DE CONSULTA</label>
                <div style="display:flex; gap:8px;">
                    <div style="flex:1;">
                        <label style="font-size:9px;color:var(--t3);font-weight:800;display:block;margin-bottom:4px;">PARTICULAR (R$)</label>
                        <input type="text" class="inp" id="edit-price-particular-${id}" value="${d.priceParticular || ''}" placeholder="0,00" style="padding:6px 8px;">
                    </div>
                    <div style="flex:1;">
                        <label style="font-size:9px;color:var(--t3);font-weight:800;display:block;margin-bottom:4px;">CARTÃO FISIOCENTER (R$)</label>
                        <input type="text" class="inp" id="edit-price-cartao-${id}" value="${d.priceCartao || ''}" placeholder="0,00" style="padding:6px 8px;">
                    </div>
                </div>
            </div>
            ${convHtml}
            ${procHtml}
            <div style="display:flex;gap:8px;margin-top:4px;">
                <button class="btn btn-ghost" style="flex:1" onclick="renderCfgBody('medicos')">✕ Cancelar</button>
                <button class="btn btn-primary" style="flex:1" onclick="saveDoctorEdit('${id}')">✓ Salvar</button>
            </div>
        </div>
    `;
}

function saveDoctorEdit(id) {
    const cleanName = document.getElementById(`edit-d-name-${id}`).value;
    const spec = document.getElementById(`edit-d-spec-${id}`).value;
    const row = document.getElementById(`row-d-${id}`);

    const prefixBtn = document.querySelector(`#edit-tglPrefix-${id} .active`);
    const prefix = prefixBtn ? prefixBtn.getAttribute('data-val') : 'Dr.';

    const typeBtn = document.querySelector(`#edit-tglType-${id} .active`);
    const type = typeBtn ? typeBtn.getAttribute('data-val') : 'hora';

    const defNatureBtn = document.querySelector(`#edit-tglDefNature-${id} .active`);
    const defaultNature = defNatureBtn ? defNatureBtn.getAttribute('data-val') : '';

    const checkedConvenios = row ? [...row.querySelectorAll('input[data-conv-id]:checked')].map(i => i.getAttribute('data-conv-id')) : [];
    const checkedProcs = row ? [...row.querySelectorAll('input[data-proc-id]:checked')].map(i => i.getAttribute('data-proc-id')) : [];

    const d = S.doctors.find(x => x.id === id);
    if(cleanName && d) {
        d.name = prefix + ' ' + cleanName;
        d.spec = spec;
        d.type = type;
        d.defaultNature = defaultNature || null;
        d.convenios = checkedConvenios;
        d.procedimentos = checkedProcs;
        if (defaultNature === 'Consulta' || defaultNature === 'Consulta/Sessão') {
            const pp = document.getElementById(`edit-price-particular-${id}`)?.value.trim();
            const pc = document.getElementById(`edit-price-cartao-${id}`)?.value.trim();
            d.priceParticular = pp || null;
            d.priceCartao = pc || null;
        } else {
            d.priceParticular = null;
            d.priceCartao = null;
        }
        saveConfig();
        renderCfgBody('medicos');
        showToast('MÉDICO ATUALIZADO COM SUCESSO!');
    }
}

// OPERAÇÕES BÁSICAS
function addUnit(){ const v=document.getElementById('newUnitInp').value.toUpperCase(); if(!v)return; S.units.push({id:'u'+Date.now(), name:v, rooms:[]}); saveConfig(); renderUnitSelect(); renderCfgBody('unidade'); }
function deleteUnit(id){ if(!confirm("EXCLUIR UNIDADE?"))return; S.units=S.units.filter(u=>u.id!==id); if(S.currentUnit===id){const first=S.units.find(u=>!u.archived);S.currentUnit=first?.id||null;} saveConfig(); renderUnitSelect(); renderCfgBody('unidade'); }
function archiveUnit(id){ const u=S.units.find(x=>x.id===id); if(u){u.archived=true; if(S.currentUnit===id){const first=S.units.find(x=>!x.archived);S.currentUnit=first?.id||null;} saveConfig(); renderUnitSelect(); renderCfgBody('unidade'); showToast("UNIDADE ARQUIVADA"); renderMain(); } }
function unarchiveUnit(id){ const u=S.units.find(x=>x.id===id); if(u){u.archived=false; saveConfig(); renderUnitSelect(); renderCfgBody('unidade'); showToast("UNIDADE REATIVADA"); } }

function addRoom(){ const v=document.getElementById('newRoomInp').value.toUpperCase(); const unit=S.units.find(u=>u.id===S.currentUnit); if(!v||!unit)return; unit.rooms.push({id:'r'+Date.now(), name:v}); saveConfig(); renderCfgBody('salas'); renderMain(); }
function deleteRoom(id){ const unit=S.units.find(u=>u.id===S.currentUnit); if(!unit)return; unit.rooms=unit.rooms.filter(r=>r.id!==id); saveConfig(); renderCfgBody('salas'); renderMain(); }
function archiveRoom(id) {
    const today = fmt(new Date());
    const row = document.getElementById(`row-r-${id}`);
    if (!row) return;
    row.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;flex:1;flex-wrap:wrap;">
            <span style="font-size:10px;color:var(--t2);white-space:nowrap;">Arquivar a partir de:</span>
            <input type="date" class="inp" id="archive-date-r-${id}" value="${today}" style="width:145px;padding:5px 8px;font-size:12px;">
        </div>
        <div class="cfg-row-actions">
            <button class="btn btn-archive" style="padding:5px 10px;" onclick="confirmArchiveRoom('${id}')">✓</button>
            <button class="btn btn-ghost" style="padding:5px 10px;" onclick="renderCfgBody('salas')">✕</button>
        </div>`;
}
function confirmArchiveRoom(id) {
    const dateVal = document.getElementById(`archive-date-r-${id}`)?.value;
    const unit = S.units.find(u => u.id === S.currentUnit);
    const r = unit?.rooms.find(x => x.id === id);
    if (r && dateVal) {
        r.archivedFrom = dateVal;
        delete r.archived;
        saveConfig(); renderCfgBody('salas'); renderMain();
        showToast("SALA ARQUIVADA A PARTIR DE " + dateVal);
    }
}
function unarchiveRoom(id) {
    const unit = S.units.find(u => u.id === S.currentUnit);
    const r = unit?.rooms.find(x => x.id === id);
    if (r) {
        delete r.archivedFrom; delete r.archived;
        saveConfig(); renderCfgBody('salas'); renderMain(); showToast("SALA REATIVADA");
    }
}

function addDoctor(){
    const name=document.getElementById('newDocName').value; if(!name)return;
    const spec=document.getElementById('newDocSpec').value || 'Geral';
    const doc = {id:'d'+Date.now(), name: curTgl.tglPrefix+' '+name, spec, type: curTgl.tglType, unitId: S.currentUnit};
    if (curTgl.tglDefaultNature) doc.defaultNature = curTgl.tglDefaultNature;
    if (curTgl.tglDefaultNature === 'Consulta' || curTgl.tglDefaultNature === 'Consulta/Sessão') {
        const pp = document.getElementById('newDocPriceParticular')?.value.trim();
        const pc = document.getElementById('newDocPriceCartao')?.value.trim();
        if (pp) doc.priceParticular = pp;
        if (pc) doc.priceCartao = pc;
    }
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

function renderUnitSelect() {
    const activeUnits = S.units.filter(u => !u.archived);
    // Se a unidade atual foi arquivada, muda para a primeira disponível
    if (!activeUnits.find(u => u.id === S.currentUnit) && activeUnits.length > 0) {
        S.currentUnit = activeUnits[0].id;
        saveLocal();
    }
    document.getElementById('unitSelect').innerHTML = activeUnits.map(u => `<option value="${u.id}" ${S.currentUnit===u.id?'selected':''}>${u.name}</option>`).join('');
}

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

// ── DASHBOARD ──────────────────────────────────────────────────────
function setDashRange(v) { dashRange = v; renderDashboard(); }
function setDashGroup(v) { dashGroupBy = v; renderDashboard(); }

function renderDashboard() {
    const el = document.getElementById('mainContent');
    const unit = S.units.find(u => u.id === S.currentUnit);
    if (!unit) { el.innerHTML = ''; return; }

    // ── Intervalo de datas ──
    const now = new Date();
    let startDate, endDate;
    if (dashRange === 'month') {
        startDate = fmt(new Date(now.getFullYear(), now.getMonth(), 1));
        endDate   = fmt(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    } else if (dashRange === '3m') {
        startDate = fmt(new Date(now.getFullYear(), now.getMonth() - 2, 1));
        endDate   = fmt(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    } else if (dashRange === '6m') {
        startDate = fmt(new Date(now.getFullYear(), now.getMonth() - 5, 1));
        endDate   = fmt(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    } else {
        startDate = dashCustomStart || fmt(new Date(now.getFullYear(), now.getMonth(), 1));
        endDate   = dashCustomEnd   || fmt(now);
    }

    // ── Filtra slots da unidade e período ──
    const entries = Object.entries(S.slots).filter(([key]) => {
        const p = key.split('|');
        return p[0] === S.currentUnit && p[2] >= startDate && p[2] <= endDate;
    });

    // ── KPIs ──
    const realEntries = entries.filter(([,s]) => s.status !== 'feriado' && s.status !== 'manutencao' && s.status !== 'diasuS');
    const ativos      = realEntries.filter(([,s]) => s.status === 'active').length;
    const cancelados  = realEntries.filter(([,s]) => s.status === 'canceled').length;
    const total       = realEntries.length;
    const taxaCancel  = total > 0 ? ((cancelados / total) * 100).toFixed(1) : '0.0';
    const profIds     = new Set(realEntries.filter(([,s]) => s.doctorId).map(([,s]) => s.doctorId));

    // ── Agrupamento por semana/mês ──
    function wKey(dateStr) { return fmt(monday(parse(dateStr))); }
    function mKey(dateStr) { return dateStr.slice(0, 7); }
    const gKey = dashGroupBy === 'week' ? wKey : mKey;

    function buildGroups(filterFn) {
        const g = {};
        entries.filter(([,s]) => filterFn(s)).forEach(([key]) => {
            const k = gKey(key.split('|')[2]);
            g[k] = (g[k] || 0) + 1;
        });
        return g;
    }
    const ativoGrp  = buildGroups(s => s.status === 'active');
    const cancelGrp = buildGroups(s => s.status === 'canceled');
    const allKeys   = [...new Set([...Object.keys(ativoGrp), ...Object.keys(cancelGrp)])].sort();

    function periodLabel(k) {
        if (dashGroupBy === 'week') {
            const mon = parse(k);
            const sat = new Date(mon); sat.setDate(mon.getDate() + 5);
            return `${mon.getDate()}/${mon.getMonth()+1} — ${sat.getDate()}/${sat.getMonth()+1}`;
        }
        const [y, m] = k.split('-');
        return `${MONTHS_PT[+m-1].slice(0,3)} ${y}`;
    }

    // ── Frequência dos profissionais ──
    const profFreq = {};
    realEntries.forEach(([,s]) => {
        if (!s.doctorId) return;
        if (!profFreq[s.doctorId]) profFreq[s.doctorId] = { active: 0, canceled: 0 };
        if (s.status === 'active')   profFreq[s.doctorId].active++;
        if (s.status === 'canceled') profFreq[s.doctorId].canceled++;
    });
    const sortedProfs  = Object.entries(profFreq).sort((a,b) => (b[1].active+b[1].canceled) - (a[1].active+a[1].canceled));
    const maxProfTotal = sortedProfs.length > 0 ? sortedProfs[0][1].active + sortedProfs[0][1].canceled : 1;
    const maxBar       = Math.max(1, ...Object.values(ativoGrp), ...Object.values(cancelGrp));
    const maxCancel    = Math.max(1, ...Object.values(cancelGrp));

    // ── Helpers de barra ──
    const barHTML = (val, max, cls) => `
        <div class="dash-bar-track"><div class="dash-bar-fill ${cls}" style="width:${Math.round((val/max)*100)}%"></div></div>`;

    const emptyMsg = `<div class="dash-empty">Sem dados no período selecionado.</div>`;

    // ── HTML ──
    el.innerHTML = `
    <div class="dash-wrap">

      <!-- Filtros -->
      <div class="dash-filters">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <span style="font-size:10px;font-weight:800;color:var(--t3);text-transform:uppercase;white-space:nowrap;">Período:</span>
          <div class="toggle-group" style="width:auto;gap:4px;">
            <button class="tgl-btn ${dashRange==='month'?'active':''}" style="padding:5px 12px;flex:none;" onclick="setDashRange('month')">Mês Atual</button>
            <button class="tgl-btn ${dashRange==='3m'?'active':''}" style="padding:5px 12px;flex:none;" onclick="setDashRange('3m')">3 Meses</button>
            <button class="tgl-btn ${dashRange==='6m'?'active':''}" style="padding:5px 12px;flex:none;" onclick="setDashRange('6m')">6 Meses</button>
            <button class="tgl-btn ${dashRange==='custom'?'active':''}" style="padding:5px 12px;flex:none;" onclick="setDashRange('custom')">Personalizado</button>
          </div>
          ${dashRange === 'custom' ? `
            <input type="date" class="inp" value="${dashCustomStart}" onchange="dashCustomStart=this.value;renderDashboard()" style="width:140px;padding:5px 8px;font-size:11px;">
            <span style="color:var(--t3);font-size:11px;">até</span>
            <input type="date" class="inp" value="${dashCustomEnd}" onchange="dashCustomEnd=this.value;renderDashboard()" style="width:140px;padding:5px 8px;font-size:11px;">
          ` : `<span style="font-size:10px;color:var(--t2);font-weight:700;">${startDate} → ${endDate}</span>`}
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:10px;font-weight:800;color:var(--t3);text-transform:uppercase;white-space:nowrap;">Agrupar por:</span>
          <div class="toggle-group" style="width:auto;gap:4px;">
            <button class="tgl-btn ${dashGroupBy==='week'?'active':''}" style="padding:5px 12px;flex:none;" onclick="setDashGroup('week')">Semana</button>
            <button class="tgl-btn ${dashGroupBy==='month'?'active':''}" style="padding:5px 12px;flex:none;" onclick="setDashGroup('month')">Mês</button>
          </div>
        </div>
      </div>

      <!-- KPIs -->
      <div class="dash-kpis">
        <div class="dash-kpi">
          <div class="dash-kpi-val">${ativos}</div>
          <div class="dash-kpi-label">Atendimentos Ativos</div>
        </div>
        <div class="dash-kpi dash-kpi--cancel">
          <div class="dash-kpi-val">${cancelados}</div>
          <div class="dash-kpi-label">Cancelamentos</div>
        </div>
        <div class="dash-kpi dash-kpi--prof">
          <div class="dash-kpi-val">${profIds.size}</div>
          <div class="dash-kpi-label">Profissionais Ativos</div>
        </div>
        <div class="dash-kpi dash-kpi--rate">
          <div class="dash-kpi-val">${taxaCancel}%</div>
          <div class="dash-kpi-label">Taxa de Cancelamento</div>
        </div>
      </div>

      <!-- Gráficos de barras -->
      <div class="dash-charts-row">
        <div class="dash-chart-card">
          <div class="dash-chart-title">Atendimentos por ${dashGroupBy === 'week' ? 'Semana' : 'Mês'}</div>
          <div class="dash-bars">
            ${allKeys.length === 0 ? emptyMsg : allKeys.map(k => `
              <div class="dash-bar-row">
                <div class="dash-bar-label">${periodLabel(k)}</div>
                ${barHTML(ativoGrp[k]||0, maxBar, 'dash-bar-active')}
                <div class="dash-bar-val">${ativoGrp[k]||0}</div>
              </div>`).join('')}
          </div>
        </div>
        <div class="dash-chart-card">
          <div class="dash-chart-title">Cancelamentos por ${dashGroupBy === 'week' ? 'Semana' : 'Mês'}</div>
          <div class="dash-bars">
            ${allKeys.length === 0 ? emptyMsg : allKeys.map(k => `
              <div class="dash-bar-row">
                <div class="dash-bar-label">${periodLabel(k)}</div>
                ${barHTML(cancelGrp[k]||0, maxCancel, 'dash-bar-cancel')}
                <div class="dash-bar-val">${cancelGrp[k]||0}</div>
              </div>`).join('')}
          </div>
        </div>
      </div>

      <!-- Tabela de profissionais -->
      <div class="dash-prof-card">
        <div class="dash-chart-title">Frequência dos Profissionais no Período</div>
        ${sortedProfs.length === 0 ? emptyMsg : `
        <table class="dash-table">
          <thead>
            <tr>
              <th>Profissional</th>
              <th>Especialidade</th>
              <th style="text-align:right;">Ativos</th>
              <th style="text-align:right;">Cancelados</th>
              <th style="text-align:right;">Total</th>
              <th style="text-align:right;">Taxa Canc.</th>
              <th style="min-width:120px;">Frequência</th>
            </tr>
          </thead>
          <tbody>
            ${sortedProfs.map(([docId, c]) => {
                const doc = S.doctors.find(d => d.id === docId);
                if (!doc) return '';
                const tot  = c.active + c.canceled;
                const taxa = tot > 0 ? ((c.canceled / tot) * 100).toFixed(1) : '0.0';
                const taxaColor = +taxa > 20 ? 'var(--cancel)' : +taxa > 10 ? 'var(--feriado)' : 'var(--active)';
                const pct  = Math.round((tot / maxProfTotal) * 100);
                return `<tr>
                  <td style="font-weight:700;">${doc.name}</td>
                  <td style="color:var(--t2);font-style:italic;">${doc.spec}</td>
                  <td style="text-align:right;color:var(--active);font-weight:700;">${c.active}</td>
                  <td style="text-align:right;color:var(--cancel);font-weight:700;">${c.canceled}</td>
                  <td style="text-align:right;font-weight:900;">${tot}</td>
                  <td style="text-align:right;font-weight:700;color:${taxaColor};">${taxa}%</td>
                  <td><div class="dash-bar-track" style="height:8px;"><div class="dash-bar-fill dash-bar-active" style="width:${pct}%;height:8px;border-radius:2px;"></div></div></td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>`}
      </div>

    </div>`;
}

init();

// ── TOOLTIP CUSTOMIZADO ──
let _tipPinned = false;

function _showTip(text, x, y) {
    if (_tipPinned) return;
    const tt = document.getElementById('customTooltip');
    const body = document.getElementById('customTooltipBody');
    if (!tt || !body) return;
    body.textContent = text;
    tt.classList.remove('pinned');
    document.getElementById('tooltipPin').style.display = 'none';
    tt.style.display = 'block';
    _moveTip(tt, x, y);
}

function _moveTip(tt, x, y) {
    tt = tt || document.getElementById('customTooltip');
    if (!tt || tt.style.display === 'none') return;
    const w = tt.offsetWidth || 240;
    const h = tt.offsetHeight || 100;
    let left = x + 16;
    let top  = y + 16;
    if (left + w > window.innerWidth  - 8) left = x - w - 8;
    if (top  + h > window.innerHeight - 8) top  = y - h - 8;
    tt.style.left = Math.max(8, left) + 'px';
    tt.style.top  = Math.max(8, top)  + 'px';
}

function _hideTip() {
    if (_tipPinned) return;
    const tt = document.getElementById('customTooltip');
    if (tt) tt.style.display = 'none';
}

function _pinTip(text, x, y) {
    _tipPinned = false;
    _showTip(text, x, y);
    _tipPinned = true;
    const tt = document.getElementById('customTooltip');
    if (!tt) return;
    tt.classList.add('pinned');
    document.getElementById('tooltipPin').style.display = 'inline';
}

function _dismissTip() {
    _tipPinned = false;
    const tt = document.getElementById('customTooltip');
    if (tt) { tt.style.display = 'none'; tt.classList.remove('pinned'); }
}

function handleSlotClick(e, key) {
    if (isEditActive(S.currentUnit)) return;
    e.stopPropagation();
    if (_tipPinned) _dismissTip();
}

function handleNameTipClick(e, key) {
    if (isEditActive(S.currentUnit)) return; // deixa borbulhar para handleSlotClick → openAlloc
    e.stopPropagation();
    const nameEl = e.currentTarget;
    const text = nameEl ? nameEl.getAttribute('data-tip') : null;
    if (!text) return;
    if (_tipPinned) { _dismissTip(); return; }
    _pinTip(text, e.clientX, e.clientY);
}

document.addEventListener('click', function(e) {
    if (!_tipPinned) return;
    if (!e.target.closest('.doc-name-tip[data-tip]')) _dismissTip();
});
