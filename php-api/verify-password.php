<?php
// Porta de api/verify-password.js. Mantém o contrato exato consumido por
// tryUnlock() em script.js: {ok: bool, role?: 'admin'|'ambulatorio'|'fisioterapia'|'abaetetuba'}.
// Esses valores de role são comparados por string exata contra ROLE_UNIT_NAME
// no front — não podem mudar.
require_once __DIR__ . '/_auth.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_out(['error' => 'Method not allowed'], 405);
}

$body = json_input();
$password = $body['password'] ?? null;

if (!$password) {
    json_out(['ok' => false], 400);
}

$passAdmin        = env_get('PASS_ADMIN');
$passAmbulatorio  = env_get('PASS_AMBULATORIO');
$passFisioterapia = env_get('PASS_FISIOTERAPIA');
$passAbaetetuba   = env_get('PASS_ABAETETUBA');

$role = null;
if ($passAdmin && hash_equals($passAdmin, $password)) {
    $role = 'admin';
} elseif ($passAmbulatorio && hash_equals($passAmbulatorio, $password)) {
    $role = 'ambulatorio';
} elseif ($passFisioterapia && hash_equals($passFisioterapia, $password)) {
    $role = 'fisioterapia';
} elseif ($passAbaetetuba && hash_equals($passAbaetetuba, $password)) {
    $role = 'abaetetuba';
}

if ($role === null) {
    json_out(['ok' => false], 200);
}

auth_start_session();
session_regenerate_id(true);
$_SESSION['role'] = $role;

json_out(['ok' => true, 'role' => $role], 200);
