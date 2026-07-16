-- ============================================================================
-- Schema MySQL/MariaDB para o Mapa de Sala - CS Fisiocenter
-- Substitui as tabelas mapa_config (blob JSON) e mapa_slots do Supabase por um
-- schema relacional normalizado. Testado contra a sintaxe MySQL 5.7+/MariaDB 10.2+.
--
-- Rode este arquivo inteiro uma vez, num banco vazio, antes de rodar
-- migrate/import_from_supabase.php.
-- ============================================================================

SET NAMES utf8mb4;

-- 1. UNIDADES -----------------------------------------------------------------
CREATE TABLE units (
  id       VARCHAR(64)  NOT NULL PRIMARY KEY,
  name     VARCHAR(255) NOT NULL,
  archived TINYINT(1)   NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. SALAS ----------------------------------------------------------------------
CREATE TABLE rooms (
  id             VARCHAR(64)  NOT NULL PRIMARY KEY,
  unit_id        VARCHAR(64)  NOT NULL,
  name           VARCHAR(255) NOT NULL,
  archived       TINYINT(1)   NOT NULL DEFAULT 0,
  archived_from  DATE         NULL,
  CONSTRAINT fk_rooms_unit FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE CASCADE,
  INDEX idx_rooms_unit (unit_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. ATENDENTES -------------------------------------------------------------------
CREATE TABLE attendants (
  id      VARCHAR(64)  NOT NULL PRIMARY KEY,
  name    VARCHAR(255) NOT NULL,
  unit_id VARCHAR(64)  NULL,
  CONSTRAINT fk_attendants_unit FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE SET NULL,
  INDEX idx_attendants_unit (unit_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. MÉDICOS -----------------------------------------------------------------------
CREATE TABLE doctors (
  id               VARCHAR(64)  NOT NULL PRIMARY KEY,
  name             VARCHAR(255) NOT NULL,
  spec             VARCHAR(255) NULL,
  type             VARCHAR(32)  NULL,           -- 'ordem' | 'hora'
  unit_id          VARCHAR(64)  NULL,
  attendant_id     VARCHAR(64)  NULL,
  archived         TINYINT(1)   NOT NULL DEFAULT 0,
  default_nature   VARCHAR(64)  NULL,
  price_cartao     VARCHAR(32)  NULL,           -- texto: dados reais misturam "80", "80,00", "-", null
  price_particular VARCHAR(32)  NULL,
  convenios        JSON         NULL,
  procedimentos    JSON         NULL,
  real_clinic_id   VARCHAR(64)  NULL,
  CONSTRAINT fk_doctors_unit FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE SET NULL,
  CONSTRAINT fk_doctors_attendant FOREIGN KEY (attendant_id) REFERENCES attendants(id) ON DELETE SET NULL,
  INDEX idx_doctors_unit (unit_id),
  INDEX idx_doctors_attendant (attendant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. TABELA DE PREÇOS ------------------------------------------------------------------
CREATE TABLE price_entries (
  id               VARCHAR(64)  NOT NULL PRIMARY KEY,
  label            VARCHAR(255) NULL,
  nature           VARCHAR(64)  NULL,
  service_label    VARCHAR(255) NULL,
  unit_id          VARCHAR(64)  NULL,
  doctor_id        VARCHAR(64)  NULL,
  price_cartao     VARCHAR(32)  NULL,
  price_particular VARCHAR(32)  NULL,
  CONSTRAINT fk_price_unit FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE CASCADE,
  CONSTRAINT fk_price_doctor FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE SET NULL,
  INDEX idx_price_unit (unit_id),
  INDEX idx_price_doctor (doctor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. SLOTS DA AGENDA (substitui mapa_slots) -----------------------------------------------
-- slot_key mantém o formato "unitId|roomId|date|period" já usado pelo app pra endereçar
-- células da grade. As colunas normalizadas (unit_id/room_id/slot_date/period) são
-- derivadas do slot_key no momento da gravação (api/slots.php faz explode('|', $key)) —
-- dão integridade referencial de verdade sem o front precisar mandar mais nada.
CREATE TABLE slots (
  slot_key   VARCHAR(191) NOT NULL PRIMARY KEY,
  unit_id    VARCHAR(64)  NOT NULL,
  room_id    VARCHAR(64)  NULL,        -- NULL no caso especial "diasuS" (marcador de dia, sem sala)
  slot_date  DATE         NOT NULL,
  period     VARCHAR(16)  NOT NULL,    -- 'manha' | 'tarde' | 'dia'
  doctor_id  VARCHAR(64)  NULL,
  status     VARCHAR(32)  NULL,        -- active | canceled | feriado | manutencao | diasuS
  nature     VARCHAR(64)  NULL,
  obs        TEXT         NULL,
  updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_slots_unit FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE CASCADE,
  CONSTRAINT fk_slots_doctor FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE SET NULL,
  INDEX idx_slots_unit_date (unit_id, slot_date),
  INDEX idx_slots_doctor (doctor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. CACHE DE TOKEN DA REALCLINIC ------------------------------------------------------------
-- Substitui a variável em memória do processo Node (perdida a cada cold start no Vercel).
-- Em PHP-FPM cada request é um processo novo, então o token precisa ficar em algum lugar
-- durável entre requisições — uma linha de tabela resolve sem precisar de Redis/APCu.
CREATE TABLE realclinic_token (
  id         TINYINT(1) NOT NULL PRIMARY KEY DEFAULT 1,
  token      TEXT       NULL,
  expires_at DATETIME   NULL,
  CONSTRAINT chk_realclinic_token_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO realclinic_token (id, token, expires_at) VALUES (1, NULL, NULL);
