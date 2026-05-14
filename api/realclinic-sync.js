// api/realclinic-sync.js
const REALCLINIC_URL = process.env.REALCLINIC_API_URL || 'https://saudefisiocenter.clientetdsa.com.br/SaudeFisiocenter';
const REALCLINIC_USERNAME = process.env.REALCLINIC_USERNAME;
const REALCLINIC_PASSWORD = process.env.REALCLINIC_PASSWORD;

let cachedToken = null;
let tokenExpiredAt = null;

async function getRealClinicToken() {
  if (cachedToken && tokenExpiredAt && new Date() < tokenExpiredAt) return cachedToken;
  const res = await fetch(`${REALCLINIC_URL}/Token/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: REALCLINIC_USERNAME, senha: REALCLINIC_PASSWORD })
  });
  if (!res.ok) throw new Error(`Erro ao gerar token: ${res.status}`);
  const data = await res.json();
  cachedToken = data.token || data.access_token;
  tokenExpiredAt = new Date(Date.now() + 55 * 60 * 1000);
  return cachedToken;
}

async function apiPost(endpoint, body = null) {
  const token = await getRealClinicToken();
  const res = await fetch(`${REALCLINIC_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`Erro ${endpoint}: ${res.status}`);
  return res.json();
}

async function getProcedimentoValor(idEmpresa, idConvenio, idPlano, idProcedimento) {
  try {
    const token = await getRealClinicToken();
    const res = await fetch(`${REALCLINIC_URL}/ProcedimentoIntegracao/ValorProcedimento`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ idEmpresa, idConvenio, idPlano, idProcedimento })
    });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

async function syncDoctorProcedimentoValues(idEmpresa, docRealClinicId, procedimentoIds, convenioIds, planoIds) {
  const valores = [];
  for (const idProc of procedimentoIds) {
    for (let i = 0; i < convenioIds.length; i++) {
      const valor = await getProcedimentoValor(idEmpresa, convenioIds[i], planoIds[i], idProc);
      if (valor) valores.push({ procedimentoId: idProc, convenioId: convenioIds[i], valor: valor.Valor || valor.valor || 0 });
      await new Promise(r => setTimeout(r, 100));
    }
  }
  return valores;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { action, idEmpresa, procedimentoIds, convenioIds, planoIds, docRealClinicId } = req.body;
  try {
    switch (action) {
      case 'list-professionals':
        return res.status(200).json(await apiPost('/ProfissionalIntegracao/Pesquisar', { idEmpresa }));
      case 'list-convenios':
        return res.status(200).json(await apiPost('/ConvenioIntegracao/Pesquisar'));
      case 'list-procedimentos':
        return res.status(200).json(await apiPost('/ProcedimentoIntegracao/PesquisarProcedimentos'));
      case 'get-valor':
        return res.status(200).json(await getProcedimentoValor(req.body.idEmpresa, req.body.idConvenio, req.body.idPlano, req.body.idProcedimento) || {});
      case 'sync-doctor-valores':
        return res.status(200).json(await syncDoctorProcedimentoValues(idEmpresa, docRealClinicId, procedimentoIds, convenioIds, planoIds));
      default:
        return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (error) {
    console.error('Erro na API RealClinic:', error);
    return res.status(500).json({ error: error.message });
  }
}
