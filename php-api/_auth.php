<?php
require_once __DIR__ . '/_db.php';

function auth_start_session(): void {
    if (session_status() === PHP_SESSION_NONE) {
        session_set_cookie_params([
            'lifetime' => 0,
            'path'     => '/',
            'samesite' => 'Lax',
            // 'secure' fica a cargo do php.ini/nginx quando o site estiver em HTTPS
        ]);
        session_start();
    }
}

// Chamado no topo de todo endpoint de escrita (POST/PUT/DELETE em config.php e slots.php).
// Sessão é única (não distingue unidade) — mesmo nível de proteção que a senha
// admin já dá hoje no client; travar por unidade fica pra uma iteração futura.
function require_session(): void {
    auth_start_session();
    if (empty($_SESSION['role'])) {
        json_out(['error' => 'Não autenticado'], 401);
    }
}
