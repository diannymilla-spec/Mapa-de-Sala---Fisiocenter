<?php
// Porta de api/realclinic-sync.js — mesmo switch de action, mesmos endpoints,
// mesmo throttle de 100ms no loop de sync-doctor-valores. Única diferença real:
// o token da RealClinic era cacheado numa variável em memória do processo Node
// (perdida a cada cold start do Vercel); aqui vai pra tabela realclinic_token,
// porque em PHP-FPM cada request é um processo novo — sem isso, autenticaria
// de novo a cada chamada.
require_once __DIR__ . '/_db.php';

$REALCLINIC_URL      = env_get('REALCLINIC_API_URL', 'https://saudefisiocenter.clientetdsa.com.br/SaudeFisiocenter');
$REALCLINIC_USERNAME = env_get('REALCLINIC_USERNAME');
$REALCLINIC_PASSWORD = env_get('REALCLINIC_PASSWORD');

function rc_http_post(string $url, ?array $body, ?string $token = null): array {
    $ch = curl_init($url);
    $headers = ['Content-Type: application/json'];
    if ($token) $headers[] = "Authorization: Bearer {$token}";
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $body !== null ? json_encode($body, JSON_UNESCAPED_UNICODE) : null,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 30,
    ]);
    $raw    = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err    = curl_error($ch);
    curl_close($ch);
    if ($raw === false) throw new Exception("Erro de rede: {$err}");
    return ['status' => $status, 'body' => json_decode($raw, true)];
}

function rc_get_token(): string {
    global $REALCLINIC_URL, $REALCLINIC_USERNAME, $REALCLINIC_PASSWORD;
    $pdo = db();
    $row = $pdo->query('SELECT token, expires_at FROM realclinic_token WHERE id = 1')->fetch();

    if ($row && $row['token'] && $row['expires_at'] && strtotime($row['expires_at']) > time()) {
        return $row['token'];
    }

    $res = rc_http_post("{$REALCLINIC_URL}/Token/generate", [
        'usuario' => $REALCLINIC_USERNAME,
        'senha'   => $REALCLINIC_PASSWORD,
    ]);
    if ($res['status'] < 200 || $res['status'] >= 300) {
        throw new Exception("Erro ao gerar token: {$res['status']}");
    }
    $token = $res['body']['token'] ?? $res['body']['access_token'] ?? null;
    if (!$token) throw new Exception('Token não retornado pela RealClinic');

    $expiresAt = date('Y-m-d H:i:s', time() + 55 * 60); // mesma margem de segurança de 55min do original
    $stmt = $pdo->prepare('UPDATE realclinic_token SET token = ?, expires_at = ? WHERE id = 1');
    $stmt->execute([$token, $expiresAt]);

    return $token;
}

function rc_api_post(string $endpoint, ?array $body = null): array {
    global $REALCLINIC_URL;
    $token = rc_get_token();
    $res = rc_http_post("{$REALCLINIC_URL}{$endpoint}", $body, $token);
    if ($res['status'] < 200 || $res['status'] >= 300) {
        throw new Exception("Erro {$endpoint}: {$res['status']}");
    }
    return $res['body'];
}

function rc_get_procedimento_valor($idEmpresa, $idConvenio, $idPlano, $idProcedimento): ?array {
    global $REALCLINIC_URL;
    try {
        $token = rc_get_token();
        $res = rc_http_post("{$REALCLINIC_URL}/ProcedimentoIntegracao/ValorProcedimento", [
            'idEmpresa'      => $idEmpresa,
            'idConvenio'     => $idConvenio,
            'idPlano'        => $idPlano,
            'idProcedimento' => $idProcedimento,
        ], $token);
        if ($res['status'] < 200 || $res['status'] >= 300) return null;
        return $res['body'];
    } catch (Throwable $e) {
        return null;
    }
}

function rc_sync_doctor_valores($idEmpresa, $procedimentoIds, $convenioIds, $planoIds): array {
    $valores = [];
    foreach ($procedimentoIds as $idProc) {
        foreach ($convenioIds as $i => $idConvenio) {
            $valor = rc_get_procedimento_valor($idEmpresa, $idConvenio, $planoIds[$i] ?? null, $idProc);
            if ($valor) {
                $valores[] = [
                    'procedimentoId' => $idProc,
                    'convenioId'     => $idConvenio,
                    'valor'          => $valor['Valor'] ?? $valor['valor'] ?? 0,
                ];
            }
            usleep(100 * 1000); // mesmo throttle de 100ms entre chamadas do original
        }
    }
    return $valores;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_out(['error' => 'Method not allowed'], 405);
}

$body = json_input();
$action = $body['action'] ?? null;

try {
    switch ($action) {
        case 'list-professionals':
            json_out(rc_api_post('/ProfissionalIntegracao/Pesquisar', ['idEmpresa' => $body['idEmpresa'] ?? null]));
            break;
        case 'list-convenios':
            json_out(rc_api_post('/ConvenioIntegracao/Pesquisar'));
            break;
        case 'list-procedimentos':
            json_out(rc_api_post('/ProcedimentoIntegracao/PesquisarProcedimentos'));
            break;
        case 'get-valor':
            json_out(rc_get_procedimento_valor(
                $body['idEmpresa'] ?? null, $body['idConvenio'] ?? null,
                $body['idPlano'] ?? null, $body['idProcedimento'] ?? null
            ) ?? (object)[]);
            break;
        case 'sync-doctor-valores':
            json_out(rc_sync_doctor_valores(
                $body['idEmpresa'] ?? null,
                $body['procedimentoIds'] ?? [],
                $body['convenioIds'] ?? [],
                $body['planoIds'] ?? []
            ));
            break;
        default:
            json_out(['error' => 'Invalid action'], 400);
    }
} catch (Throwable $e) {
    error_log('Erro na API RealClinic: ' . $e->getMessage());
    json_out(['error' => $e->getMessage()], 500);
}
