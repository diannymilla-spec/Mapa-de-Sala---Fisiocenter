<?php
require_once __DIR__ . '/_auth.php';

auth_start_session();
$_SESSION = [];
session_destroy();

json_out(['ok' => true]);
