export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ ok: false });
  }

  const { PASS_ADMIN, PASS_AMBULATORIO, PASS_FISIOTERAPIA, PASS_ABAETETUBA } = process.env;

  // Senha mestra tem prioridade — libera todas as unidades
  if (PASS_ADMIN && password === PASS_ADMIN) {
    return res.status(200).json({ ok: true, role: 'admin' });
  }

  // Senhas por unidade
  if (PASS_AMBULATORIO && password === PASS_AMBULATORIO) {
    return res.status(200).json({ ok: true, role: 'ambulatorio' });
  }
  if (PASS_FISIOTERAPIA && password === PASS_FISIOTERAPIA) {
    return res.status(200).json({ ok: true, role: 'fisioterapia' });
  }
  if (PASS_ABAETETUBA && password === PASS_ABAETETUBA) {
    return res.status(200).json({ ok: true, role: 'abaetetuba' });
  }

  return res.status(200).json({ ok: false });
}
