<?php
// Parser mínimo de .env (mesmo formato KEY=VALUE do .env que já existe na raiz
// do projeto). Sem dependência externa (sem Composer) — o projeto todo já segue
// essa pegada de "zero build step".

function env_load(): array {
    static $vars = null;
    if ($vars !== null) return $vars;

    $vars = [];
    $path = dirname(__DIR__) . '/.env';
    if (!is_file($path)) return $vars;

    foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        $line = trim($line);
        if ($line === '' || $line[0] === '#' || !str_contains($line, '=')) continue;
        [$key, $value] = explode('=', $line, 2);
        $vars[trim($key)] = trim($value);
    }
    return $vars;
}

function env_get(string $key, ?string $default = null): ?string {
    $vars = env_load();
    return $vars[$key] ?? $default;
}
