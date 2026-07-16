<?php
// Script CLI de migração única: lê mapa_config + mapa_slots direto da REST API
// do Supabase (com a mesma chave publishable que já está em uso hoje) e grava
// nas tabelas normalizadas do MySQL (rode mysql/schema.sql ANTES deste script).
//
// Uso (na VPS, depois de configurar o .env com SUPABASE_URL/SUPABASE_KEY e as
// credenciais DB_*):
//   php migrate/import_from_supabase.php
//
// Idempotente: pode rodar de novo sem duplicar (usa upsert em tudo).

if (php_sapi_name() !== 'cli') {
    http_response_code(403);
    die("Este script só roda via linha de comando (CLI), não é um endpoint web.\n");
}

require_once __DIR__ . '/../api/_db.php';

$SUPABASE_URL = env_get('SUPABASE_URL');
$SUPABASE_KEY = env_get('SUPABASE_KEY');
if (!$SUPABASE_URL || !$SUPABASE_KEY) {
    die("Faltam SUPABASE_URL/SUPABASE_KEY no .env — necessários só para esta migração pontual.\n");
}

function supabase_get(string $path, array $extraHeaders = []): array {
    global $SUPABASE_URL, $SUPABASE_KEY;
    $ch = curl_init("{$SUPABASE_URL}/rest/v1/{$path}");
    curl_setopt_array($ch, [
        CURLOPT_HTTPHEADER => array_merge([
            "apikey: {$SUPABASE_KEY}",
            "Authorization: Bearer {$SUPABASE_KEY}",
        ], $extraHeaders),
        CURLOPT_RETURNTRANSFER => true,
    ]);
    $raw = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($status < 200 || $status >= 300) {
        die("Erro consultando Supabase ({$path}): HTTP {$status}\n{$raw}\n");
    }
    return json_decode($raw, true) ?: [];
}

function supabase_get_all_slots(): array {
    $all = [];
    $offset = 0;
    $pageSize = 1000; // limite default de linhas por página da REST API do Supabase
    while (true) {
        $page = supabase_get('mapa_slots?select=*', [
            "Range-Unit: items",
            "Range: {$offset}-" . ($offset + $pageSize - 1),
        ]);
        if (empty($page)) break;
        $all = array_merge($all, $page);
        if (count($page) < $pageSize) break;
        $offset += $pageSize;
    }
    return $all;
}

echo "Lendo mapa_config do Supabase...\n";
$configRows = supabase_get('mapa_config?select=*');
$byId = [];
foreach ($configRows as $row) $byId[$row['id']] = $row['data'] ?? [];

$units        = $byId['units']        ?? [];
$doctorsRaw   = $byId['doctors']      ?? [];
$attendants   = $byId['attendants']   ?? [];
$priceEntries = $byId['priceEntries'] ?? [];

echo "Lendo mapa_slots do Supabase (paginado)...\n";
$slots = supabase_get_all_slots();

echo "Encontrado: " . count($units) . " units, " . count($doctorsRaw) . " doctors, "
   . count($attendants) . " attendants, " . count($priceEntries) . " priceEntries, "
   . count($slots) . " slots.\n";

$pdo = db();
$pdo->beginTransaction();

try {
    // 1. Units
    $stmt = $pdo->prepare('INSERT INTO units (id, name, archived) VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE name = VALUES(name), archived = VALUES(archived)');
    foreach ($units as $u) {
        $stmt->execute([$u['id'], $u['name'], !empty($u['archived']) ? 1 : 0]);
    }
    echo "  units importadas.\n";

    // 2. Rooms (aninhadas em units[].rooms)
    $stmt = $pdo->prepare('INSERT INTO rooms (id, unit_id, name, archived, archived_from) VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE unit_id = VALUES(unit_id), name = VALUES(name),
        archived = VALUES(archived), archived_from = VALUES(archived_from)');
    $roomCount = 0;
    foreach ($units as $u) {
        foreach (($u['rooms'] ?? []) as $r) {
            $archivedFrom = !empty($r['archivedFrom']) ? $r['archivedFrom'] : null;
            $stmt->execute([$r['id'], $u['id'], $r['name'], !empty($r['archived']) ? 1 : 0, $archivedFrom]);
            $roomCount++;
        }
    }
    echo "  {$roomCount} rooms importadas.\n";

    // 3. Attendants
    $stmt = $pdo->prepare('INSERT INTO attendants (id, name, unit_id) VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE name = VALUES(name), unit_id = VALUES(unit_id)');
    foreach ($attendants as $a) {
        $stmt->execute([$a['id'], $a['name'], $a['unitId'] ?? null]);
    }
    echo "  attendants importados.\n";

    // 4. Doctors
    $stmt = $pdo->prepare('INSERT INTO doctors
        (id, name, spec, type, unit_id, attendant_id, archived, default_nature, price_cartao, price_particular, convenios, procedimentos, real_clinic_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE name = VALUES(name), spec = VALUES(spec), type = VALUES(type),
        unit_id = VALUES(unit_id), attendant_id = VALUES(attendant_id), archived = VALUES(archived),
        default_nature = VALUES(default_nature), price_cartao = VALUES(price_cartao),
        price_particular = VALUES(price_particular), convenios = VALUES(convenios),
        procedimentos = VALUES(procedimentos), real_clinic_id = VALUES(real_clinic_id)');
    $knownDoctorIds = [];
    $knownAttendantIds = array_column($attendants, 'id');
    foreach ($doctorsRaw as $d) {
        // attendantId órfão (atendente já excluído) vira NULL em vez de derrubar a
        // linha inteira — mesma tolerância usada na migração equivalente pro Postgres.
        $attendantId = (!empty($d['attendantId']) && in_array($d['attendantId'], $knownAttendantIds, true))
            ? $d['attendantId'] : null;
        $stmt->execute([
            $d['id'], $d['name'], $d['spec'] ?? null, $d['type'] ?? null,
            $d['unitId'] ?? null, $attendantId, !empty($d['archived']) ? 1 : 0,
            $d['defaultNature'] ?? null, $d['priceCartao'] ?? null, $d['priceParticular'] ?? null,
            json_encode($d['convenios'] ?? [], JSON_UNESCAPED_UNICODE),
            json_encode($d['procedimentos'] ?? [], JSON_UNESCAPED_UNICODE),
            $d['realClinicId'] ?? null,
        ]);
        $knownDoctorIds[] = $d['id'];
    }
    echo "  " . count($doctorsRaw) . " doctors importados.\n";

    // 5. Price entries (o array de origem tem pelo menos 1 id duplicado — o app já
    // roda deduplicatePriceEntries() no load por causa disso — upsert absorve sem erro)
    $stmt = $pdo->prepare('INSERT INTO price_entries
        (id, label, nature, service_label, unit_id, doctor_id, price_cartao, price_particular)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE label = VALUES(label), nature = VALUES(nature),
        service_label = VALUES(service_label), unit_id = VALUES(unit_id), doctor_id = VALUES(doctor_id),
        price_cartao = VALUES(price_cartao), price_particular = VALUES(price_particular)');
    foreach ($priceEntries as $p) {
        $doctorId = (!empty($p['doctorId']) && in_array($p['doctorId'], $knownDoctorIds, true))
            ? $p['doctorId'] : null;
        $stmt->execute([
            $p['id'], $p['label'] ?? null, $p['nature'] ?? null, $p['serviceLabel'] ?? null,
            $p['unitId'] ?? null, $doctorId, $p['priceCartao'] ?? null, $p['priceParticular'] ?? null,
        ]);
    }
    echo "  " . count($priceEntries) . " price_entries importadas.\n";

    // 6. Slots
    $stmt = $pdo->prepare('INSERT INTO slots
        (slot_key, unit_id, room_id, slot_date, period, doctor_id, status, nature, obs)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE doctor_id = VALUES(doctor_id), status = VALUES(status),
        nature = VALUES(nature), obs = VALUES(obs)');
    $skipped = 0;
    foreach ($slots as $s) {
        $parts = explode('|', $s['slot_key']);
        if (count($parts) !== 4) { $skipped++; continue; }
        [$unitId, $roomId, $date, $period] = $parts;
        $doctorId = (!empty($s['doctor_id']) && in_array($s['doctor_id'], $knownDoctorIds, true))
            ? $s['doctor_id'] : null;
        $stmt->execute([
            $s['slot_key'], $unitId, $roomId === 'diasuS' ? null : $roomId, $date, $period,
            $doctorId, $s['status'] ?? null, $s['nature'] ?? null, $s['obs'] ?? '',
        ]);
    }
    echo "  " . (count($slots) - $skipped) . " slots importados" . ($skipped ? " ({$skipped} ignorados por slot_key malformado)" : '') . ".\n";

    $pdo->commit();
    echo "\nMigração concluída com sucesso.\n";
} catch (Throwable $e) {
    $pdo->rollBack();
    die("\nERRO — nada foi gravado (rollback): " . $e->getMessage() . "\n");
}
