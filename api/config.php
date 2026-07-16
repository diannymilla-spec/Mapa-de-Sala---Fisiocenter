<?php
// Substitui as leituras/escritas de mapa_config no Supabase. GET monta o mesmo
// formato aninhado que script.js já espera (units[].rooms[], arrays de
// doctors/attendants/priceEntries) a partir das tabelas normalizadas. PUT
// recebe os 4 arrays INTEIROS que saveConfig() já monta no cliente e faz um
// sync completo por tabela (upsert do que veio, delete do que sumiu) — o
// cliente nunca precisa saber que agora existem tabelas separadas.
require_once __DIR__ . '/_auth.php';

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    handleGet();
} elseif ($method === 'PUT' || $method === 'POST') {
    require_session();
    handlePut();
} else {
    json_out(['error' => 'Method not allowed'], 405);
}

function handleGet(): void {
    $pdo = db();

    $units = $pdo->query('SELECT id, name, archived FROM units ORDER BY name')->fetchAll();
    $roomsByUnit = [];
    foreach ($pdo->query('SELECT id, unit_id, name, archived, archived_from FROM rooms ORDER BY name') as $r) {
        $room = ['id' => $r['id'], 'name' => $r['name'], 'archived' => (bool)$r['archived']];
        if ($r['archived_from']) $room['archivedFrom'] = $r['archived_from'];
        $roomsByUnit[$r['unit_id']][] = $room;
    }
    $units = array_map(function ($u) use ($roomsByUnit) {
        return [
            'id'       => $u['id'],
            'name'     => $u['name'],
            'archived' => (bool)$u['archived'],
            'rooms'    => $roomsByUnit[$u['id']] ?? [],
        ];
    }, $units);

    $attendants = array_map(function ($a) {
        return ['id' => $a['id'], 'name' => $a['name'], 'unitId' => $a['unit_id']];
    }, $pdo->query('SELECT id, name, unit_id FROM attendants ORDER BY name')->fetchAll());

    $doctors = array_map(function ($d) {
        return [
            'id'               => $d['id'],
            'name'             => $d['name'],
            'spec'             => $d['spec'],
            'type'             => $d['type'],
            'unitId'           => $d['unit_id'],
            'archived'         => (bool)$d['archived'],
            'attendantId'      => $d['attendant_id'],
            'priceCartao'      => $d['price_cartao'],
            'priceParticular'  => $d['price_particular'],
            'defaultNature'    => $d['default_nature'],
            'convenios'        => $d['convenios'] ? json_decode($d['convenios'], true) : [],
            'procedimentos'    => $d['procedimentos'] ? json_decode($d['procedimentos'], true) : [],
            'realClinicId'     => $d['real_clinic_id'],
        ];
    }, $pdo->query('SELECT * FROM doctors ORDER BY name')->fetchAll());

    $priceEntries = array_map(function ($p) {
        return [
            'id'               => $p['id'],
            'label'            => $p['label'],
            'nature'           => $p['nature'],
            'serviceLabel'     => $p['service_label'],
            'unitId'           => $p['unit_id'],
            'doctorId'         => $p['doctor_id'],
            'priceCartao'      => $p['price_cartao'],
            'priceParticular'  => $p['price_particular'],
        ];
    }, $pdo->query('SELECT * FROM price_entries')->fetchAll());

    json_out([
        'units'        => $units,
        'doctors'      => $doctors,
        'attendants'   => $attendants,
        'priceEntries' => $priceEntries,
    ]);
}

function handlePut(): void {
    $pdo  = db();
    $body = json_input();

    $units        = $body['units']        ?? [];
    $doctors      = $body['doctors']      ?? [];
    $attendants   = $body['attendants']   ?? [];
    $priceEntries = $body['priceEntries'] ?? [];

    $pdo->beginTransaction();
    try {
        $unitIds      = syncUnits($pdo, $units);
        syncRooms($pdo, $units);
        $attendantIds = syncAttendants($pdo, $attendants, $unitIds);
        $doctorIds    = syncDoctors($pdo, $doctors, $unitIds, $attendantIds);
        syncPriceEntries($pdo, $priceEntries, $unitIds, $doctorIds);
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        json_out(['error' => 'Erro ao salvar configuração: ' . $e->getMessage()], 500);
    }

    json_out(['ok' => true]);
}

// Upsert das linhas em $rows (cada uma com 'id') e delete de quem não veio mais.
function deleteMissing(PDO $pdo, string $table, array $ids, string $idCol = 'id'): void {
    if (empty($ids)) {
        $pdo->exec("DELETE FROM {$table}");
        return;
    }
    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $stmt = $pdo->prepare("DELETE FROM {$table} WHERE {$idCol} NOT IN ({$placeholders})");
    $stmt->execute(array_values($ids));
}

function syncUnits(PDO $pdo, array $units): array {
    $stmt = $pdo->prepare('INSERT INTO units (id, name, archived) VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE name = VALUES(name), archived = VALUES(archived)');
    $ids = [];
    foreach ($units as $u) {
        $ids[] = $u['id'];
        $stmt->execute([$u['id'], $u['name'], !empty($u['archived']) ? 1 : 0]);
    }
    deleteMissing($pdo, 'units', $ids);
    return $ids;
}

function syncRooms(PDO $pdo, array $units): void {
    $stmt = $pdo->prepare('INSERT INTO rooms (id, unit_id, name, archived, archived_from) VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE unit_id = VALUES(unit_id), name = VALUES(name),
        archived = VALUES(archived), archived_from = VALUES(archived_from)');
    $ids = [];
    foreach ($units as $u) {
        foreach (($u['rooms'] ?? []) as $r) {
            $ids[] = $r['id'];
            $stmt->execute([
                $r['id'], $u['id'], $r['name'],
                !empty($r['archived']) ? 1 : 0,
                $r['archivedFrom'] ?? null,
            ]);
        }
    }
    deleteMissing($pdo, 'rooms', $ids);
}

function syncAttendants(PDO $pdo, array $attendants, array $validUnitIds): array {
    $stmt = $pdo->prepare('INSERT INTO attendants (id, name, unit_id) VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE name = VALUES(name), unit_id = VALUES(unit_id)');
    $ids = [];
    foreach ($attendants as $a) {
        $ids[] = $a['id'];
        $unitId = in_array($a['unitId'] ?? null, $validUnitIds, true) ? $a['unitId'] : null;
        $stmt->execute([$a['id'], $a['name'], $unitId]);
    }
    deleteMissing($pdo, 'attendants', $ids);
    return $ids;
}

// unit_id/attendant_id órfãos (apontam pra algo que não veio no payload) viram
// NULL em vez de derrubar o save inteiro por violação de FK — os dados reais já
// têm médicos assim (atendente excluído antes dessa validação existir).
function syncDoctors(PDO $pdo, array $doctors, array $validUnitIds, array $validAttendantIds): array {
    $stmt = $pdo->prepare('INSERT INTO doctors
        (id, name, spec, type, unit_id, attendant_id, archived, default_nature, price_cartao, price_particular, convenios, procedimentos, real_clinic_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE name = VALUES(name), spec = VALUES(spec), type = VALUES(type),
        unit_id = VALUES(unit_id), attendant_id = VALUES(attendant_id), archived = VALUES(archived),
        default_nature = VALUES(default_nature), price_cartao = VALUES(price_cartao),
        price_particular = VALUES(price_particular), convenios = VALUES(convenios),
        procedimentos = VALUES(procedimentos), real_clinic_id = VALUES(real_clinic_id)');
    $ids = [];
    foreach ($doctors as $d) {
        $ids[] = $d['id'];
        $unitId      = in_array($d['unitId'] ?? null, $validUnitIds, true) ? $d['unitId'] : null;
        $attendantId = in_array($d['attendantId'] ?? null, $validAttendantIds, true) ? $d['attendantId'] : null;
        $stmt->execute([
            $d['id'], $d['name'], $d['spec'] ?? null, $d['type'] ?? null,
            $unitId, $attendantId,
            !empty($d['archived']) ? 1 : 0, $d['defaultNature'] ?? null,
            $d['priceCartao'] ?? null, $d['priceParticular'] ?? null,
            json_encode($d['convenios'] ?? [], JSON_UNESCAPED_UNICODE),
            json_encode($d['procedimentos'] ?? [], JSON_UNESCAPED_UNICODE),
            $d['realClinicId'] ?? null,
        ]);
    }
    deleteMissing($pdo, 'doctors', $ids);
    return $ids;
}

function syncPriceEntries(PDO $pdo, array $entries, array $validUnitIds, array $validDoctorIds): void {
    $stmt = $pdo->prepare('INSERT INTO price_entries
        (id, label, nature, service_label, unit_id, doctor_id, price_cartao, price_particular)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE label = VALUES(label), nature = VALUES(nature),
        service_label = VALUES(service_label), unit_id = VALUES(unit_id), doctor_id = VALUES(doctor_id),
        price_cartao = VALUES(price_cartao), price_particular = VALUES(price_particular)');
    $ids = [];
    foreach ($entries as $p) {
        $ids[] = $p['id'];
        $unitId   = in_array($p['unitId'] ?? null, $validUnitIds, true) ? $p['unitId'] : null;
        $doctorId = in_array($p['doctorId'] ?? null, $validDoctorIds, true) ? $p['doctorId'] : null;
        $stmt->execute([
            $p['id'], $p['label'] ?? null, $p['nature'] ?? null, $p['serviceLabel'] ?? null,
            $unitId, $doctorId,
            $p['priceCartao'] ?? null, $p['priceParticular'] ?? null,
        ]);
    }
    deleteMissing($pdo, 'price_entries', $ids);
}
