# Plataforma de Administración de Condominios

Solución integral para administración de condominios con marketplace, turnos de conserjería,
control de pagos y módulo comunitario. Incluye backend en Node.js + SQLite y panel operativo web.

## Requisitos
- Node.js 18+
- npm

## Instalación
```bash
npm install
```

## Ejecución
```bash
npm start
```

Luego abre `http://localhost:3000`.

## Variables de entorno
Puedes personalizar la URL base para links de pago:
```bash
export HAULMER_BASE_URL="https://pagos.haulmer.com/link"
```

Para webhooks de Haulmer y seguridad:
```bash
export HAULMER_WEBHOOK_SECRET="tu-secret"
export LOGISTICS_WEBHOOK_SECRET="tu-secret-logistica"
```

## Producción recomendada
- Configurar reverse proxy (Nginx) con HTTPS.
- Habilitar logs centralizados y monitoreo.
- Programar backups de `data.sqlite`.
- Implementar CI/CD y migraciones versionadas.

## Recuperación de contraseña
El endpoint `/api/auth/request-reset` devuelve un token de reset. En producción debe enviarse
por email/SMS y no exponerlo en la respuesta.

## Flujo recomendado
1. Crear el primer **Administrador** desde el panel (bootstrap inicial).
2. Iniciar sesión con el administrador.
3. Crear perfiles y turnos.
4. Publicar items en marketplace, aprobarlos y generar órdenes/checkout.

## Seguridad
- Contraseñas con PBKDF2.
- Política de contraseña: 8+ caracteres, mayúscula, minúscula y número.
- Bloqueo por intentos fallidos y expiración de sesión.
