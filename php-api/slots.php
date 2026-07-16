<?php
// Substitui as leituras/escritas de mapa_slots no Supabase. Mantém o mesmo
// formato de linha (slot_key, doctor_id, status, nature, obs) que o cliente já
// monta/consome hoje (upsertSlot(s)/init() em script.js já trabalham em
// snake_case porque é assim que o Supabase devolvia as colunas) — só troca o
// transporte, não o formato.
require_once __DIR__ . '/_auth.php';

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    handleGet();
} elseif ($method === 'PUT' || $method === 'POST') {
    require_session();
    handleUpsert();
} elseif ($method === 'DELETE') {
    require_session();
    handleDelete();
} else {
    json_out(['error' => 'Method not allowed'], 405);
}

function handleGet(): void {
    $pdo = db();
    $rows = $pdo->query('SELECT slot_key, doctor_id, status, nature, obs FROM slots')->fetchAll();
    json_out($rows);
}

// slot_key segue o formato "unitId|roomId|date|period" (ou "unitId|diasuS|date|dia"
// pro marcador especial de dia de SUS, que não tem sala de verdade).
function parseSlotKey(string $key): ?array {
    $parts = explode('|', $key);
    if (count($parts) !== 4) return null;
    [$unitId, $roomId, $date, $period] = $parts;
    return [
        'unit_id'   => $unitId,
        'room_id'   => $roomId === 'diasuS' ? null : $roomId,
        'slot_date' => $date,
        'period'    => $period,
    ];
}

function handleUpsert(): void {
    $pdo  = db();
    $rows = json_input();
    if (!is_array($rows) || empty($rows)) json_out(['ok' => true]);
    // Body pode vir como objeto único (upsertSlot) ou array (upsertSlots) — normaliza.
    if (isset($rows['slot_key'])) $rows = [$rows];

    $stmt = $pdo->prepare('INSERT INTO slots
        (slot_key, unit_id, room_id, slot_date, period, doctor_id, status, nature, obs)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE doctor_id = VALUES(doctor_id), status = VALUES(status),
        nature = VALUES(nature), obs = VALUES(obs), unit_id = VALUES(unit_id),
        room_id = VALUES(room_id), slot_date = VALUES(slot_date), period = VALUES(period)');

    $pdo->beginTransaction();
    try {
        foreach ($rows as $row) {
            $key = $row['slot_key'] ?? null;
            $parsed = $key ? parseSlotKey($key) : null;
            if (!$parsed) continue; // linha malformada — ignora em vez de derrubar o lote inteiro
            $stmt->execute([
                $key, $parsed['unit_id'], $parsed['room_id'], $parsed['slot_date'], $parsed['period'],
                $row['doctor_id'] ?? null, $row['status'] ?? null, $row['nature'] ?? null, $row['obs'] ?? '',
            ]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        json_out(['error' => 'Erro ao salvar slots: ' . $e->getMessage()], 500);
    }

    json_out(['ok' => true]);
}

function handleDelete(): void {
    $pdo  = db();
    $body = json_input();
    $keys = $body['keys'] ?? ($body['slot_key'] ? [$body['slot_key']] : []);
    if (empty($keys)) json_out(['ok' => true]);

    $placeholders = implode(',', array_fill(0, count($keys), '?'));
    $stmt = $pdo->prepare("DELETE FROM slots WHERE slot_key IN ({$placeholders})");
    $stmt->execute(array_values($keys));

    json_out(['ok' => true]);
}
