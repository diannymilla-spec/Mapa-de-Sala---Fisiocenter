# Roteiro de deploy na VPS (Ubuntu/Debian)

Se sua VPS for outra distro (CentOS/AlmaLinux etc.), os pacotes mudam de nome
(`dnf`/`yum` em vez de `apt`), mas os passos são os mesmos.

## 1. Instalar o stack

```bash
sudo apt update
sudo apt install -y nginx mysql-server php8.2-fpm php8.2-mysql php8.2-curl git
```

(`php8.2` é só um exemplo — use `php -v` pra ver o que já está instalado, e ajuste
o nome do socket no `nginx.conf` de acordo.)

## 2. Criar o banco

```bash
sudo mysql
```
```sql
CREATE DATABASE mapa_sala CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'mapa_sala'@'localhost' IDENTIFIED BY 'ESCOLHA_UMA_SENHA_FORTE';
GRANT ALL PRIVILEGES ON mapa_sala.* TO 'mapa_sala'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

Rode o schema:
```bash
mysql -u mapa_sala -p mapa_sala < mysql/schema.sql
```

## 3. Subir os arquivos do projeto

```bash
sudo mkdir -p /var/www/mapa-de-sala
sudo chown $USER:$USER /var/www/mapa-de-sala
git clone <URL_DO_SEU_REPO> /var/www/mapa-de-sala
# (ou: rsync/scp os arquivos direto, se preferir não usar git na VPS)
```

O backend PHP mora em `php-api/` no repositório (não em `api/`) — foi movido pra lá
de propósito pra não conflitar com as funções serverless antigas do Vercel
(`api/verify-password.js`/`api/realclinic-sync.js`), que continuam servindo o site
atual no Supabase enquanto essa migração não é finalizada. **Antes de ativar o Nginx
(passo 6)**, na própria VPS:

```bash
cd /var/www/mapa-de-sala
rm -f api/verify-password.js api/realclinic-sync.js   # não existem no PHP/VPS
mv php-api/* api/
rmdir php-api
```

Isso não afeta o repositório Git nem o deploy no Vercel — é só um ajuste local na VPS.

## 4. Configurar o `.env`

Copie o `.env` que já existe na raiz do projeto e ajuste/adicione:

```
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=mapa_sala
DB_USER=mapa_sala
DB_PASS=ESCOLHA_UMA_SENHA_FORTE

PASS_ADMIN=...
PASS_AMBULATORIO=...
PASS_FISIOTERAPIA=...
PASS_ABAETETUBA=...

REALCLINIC_API_URL=https://saudefisiocenter.clientetdsa.com.br/SaudeFisiocenter
REALCLINIC_USERNAME=...
REALCLINIC_PASSWORD=...

# Só precisa disso daqui pra baixo até terminar o passo 5 (migração de dados);
# depois pode remover, o app não usa mais Supabase.
SUPABASE_URL=https://rqmdufikdxfvridzrbcn.supabase.co
SUPABASE_KEY=sb_publishable_...
```

O `.env` já está no `.gitignore` — confirme que ele **não** foi commitado.

## 5. Migrar os dados do Supabase

```bash
cd /var/www/mapa-de-sala
php migrate/import_from_supabase.php
```

Confira a contagem impressa no final contra o que existe hoje no Supabase
(Table Editor → contar linhas de cada tabela).

## 6. Configurar Nginx

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/mapa-de-sala
sudo ln -s /etc/nginx/sites-available/mapa-de-sala /etc/nginx/sites-enabled/
# edite server_name e a versão do php-fpm socket no arquivo antes de ativar
sudo nginx -t && sudo systemctl reload nginx
```

## 7. Testar tudo ANTES de desligar Vercel/Supabase

- Login com senha de unidade e com senha admin (`/api/verify-password.php`)
- Criar uma alocação e dar F5 na hora — o cenário exato que estava falhando
- Apagar uma alocação, alocação em massa (dia inteiro), arrastar um slot (drag-and-drop)
- Editar médico/sala/atendente/preço no Painel de Controle
- Sincronizar RealClinic (botão de sincronizar convênios/procedimentos + sincronizar
  valores de um médico específico)

## 8. Cutover final

Só depois de tudo validado:
1. Aponte o domínio (DNS) pra VPS, se ainda estiver usando o domínio do Vercel.
2. Rode `certbot --nginx` pra ativar HTTPS.
3. Desligue o projeto no Vercel.
4. Só então pause/exclua o projeto no Supabase.
