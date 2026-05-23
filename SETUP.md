# Familia Green Bay — Guía de instalación

Aplicación web para llevar el inventario del álbum **Panini Copa del Mundo 2026**, con escaneo automático de fichas por foto (Claude Vision), guardado en Google Sheets y login con Google.

> Tiempo estimado: ~30 minutos la primera vez.

---

## Arquitectura

```
┌─────────────────────┐        ┌──────────────────────┐        ┌──────────────────┐
│  GitHub Pages       │─POST──▶│  Google Apps Script  │─HTTPS─▶│  Claude Vision   │
│  (HTML/CSS/JS)      │        │  (Web App + Sheets)  │        │  API (Anthropic) │
│  Login con Google   │◀──JSON─│  Verifica ID token   │◀──────│                  │
└─────────────────────┘        └──────────────────────┘        └──────────────────┘
                                          │
                                          ▼
                                  ┌──────────────────┐
                                  │  Google Sheet    │
                                  │  (inventario)    │
                                  └──────────────────┘
```

---

## Paso 1 — Crear el Google Sheet (2 min)

1. Abre <https://sheets.google.com> y crea una hoja nueva.
2. Renómbrala a **"Familia Green Bay — Inventario"**.
3. De la URL, copia el **ID** (la parte entre `/d/` y `/edit`):
   ```
   https://docs.google.com/spreadsheets/d/AQUI_VA_EL_ID/edit
   ```
   Guárdalo, lo usarás en el Paso 2.

---

## Paso 2 — Configurar Google Apps Script (10 min)

### 2.1 Crear el proyecto

1. Ve a <https://script.google.com> → **Nuevo proyecto**.
2. Renómbralo a **"Familia Green Bay Backend"**.
3. Borra el contenido por defecto del archivo `Code.gs`.
4. Copia y pega TODO el contenido de [`apps-script/Code.gs`](apps-script/Code.gs).
5. En la línea 18, reemplaza `PASTE_YOUR_SHEET_ID_HERE` por el ID del Sheet del Paso 1.
6. Guarda (💾 o `Ctrl+S`).

### 2.2 Guardar tu API key de Claude como secreto

1. En el menú izquierdo del editor de Apps Script: ⚙️ **Configuración del proyecto**.
2. Baja hasta **"Propiedades del script"** → **Editar propiedades del script**.
3. Agrega:
   - **Propiedad:** `ANTHROPIC_API_KEY`
   - **Valor:** tu API key (`sk-ant-...`)
4. (Opcional, recomendado) Agrega otra propiedad para restringir el acceso a tu familia:
   - **Propiedad:** `ALLOWED_EMAILS`
   - **Valor:** `tu-email@gmail.com,familiar1@gmail.com,familiar2@gmail.com`
5. **Guardar propiedades del script**.

### 2.3 Inicializar la hoja

1. Vuelve al editor (icono `< >`).
2. ⚠️ **MUY IMPORTANTE — selecciona la función correcta:** en la barra superior del editor, entre los botones "Debug" y "Execution log", hay un dropdown que por defecto dice **`doGet`**. Haz click en ese dropdown y **cámbialo a `setupSheet`**.
   - Si dejas `doGet` y le das Run, la ejecución terminará sin error pero NO creará nada en el Sheet (porque `doGet` es el endpoint HTTP, no la función de inicialización).
3. Click ▶ **Run** (Ejecutar).
4. La primera vez te pedirá permisos:
   - "Autorizar acceso" → tu cuenta → "Avanzado" → "Ir a Familia Green Bay Backend (no seguro)" → "Permitir".
   - (Es "no seguro" solo porque la app no está verificada por Google — es tu propio código.)
5. Cuando termine ("Execution completed"), abre tu Google Sheet y refresca (F5): aparecerá un nuevo tab `Inventory` al lado de `Sheet1`, con headers `email | sticker_id | owned | count | updated_at`.

### 2.4 Desplegar como Web App

1. Click en **Desplegar** (arriba a la derecha) → **Nueva implementación**.
2. ⚙️ Icono de engrane → selecciona **"Aplicación web"**.
3. Configuración:
   - **Descripción:** `v1`
   - **Ejecutar como:** *Yo* (`tu-email@gmail.com`)
   - **Quién tiene acceso:** *Cualquier usuario* (necesario porque los familiares se autentican por su cuenta)
4. Click **Desplegar**.
5. **Copia la URL de la implementación** (termina en `/exec`). Guárdala para el Paso 4.

> ⚠️ Cada vez que cambies el código de Apps Script, debes crear una **nueva implementación** o usar **"Gestionar implementaciones"** → editar la existente y aumentar la versión. La URL del `/exec` se mantiene si editas, cambia si creas nueva.

---

## Paso 3 — Crear credenciales de Google Sign-In (10 min)

Esto permite el login con Google en el frontend.

1. Ve a <https://console.cloud.google.com>.
2. Crea un proyecto nuevo: **"Familia Green Bay"** (o usa uno existente).
3. En el menú lateral: **APIs y servicios** → **Pantalla de consentimiento de OAuth**.
   - Tipo de usuario: **Externo** → Crear.
   - Nombre de la app: `Familia Green Bay`.
   - Correo de soporte: tu email.
   - Correo del desarrollador: tu email.
   - **Guardar y continuar** en todas las pantallas (sin agregar scopes; el ID token básico es suficiente).
   - En **Usuarios de prueba**: agrega los emails de tu familia.
   - Guardar.
4. **APIs y servicios** → **Credenciales** → **Crear credenciales** → **ID de cliente OAuth**.
   - Tipo de aplicación: **Aplicación web**.
   - Nombre: `Familia Green Bay Web`.
   - **Orígenes JavaScript autorizados** (agrega TODOS los que vayas a usar):
     - `http://localhost:8000` *(para pruebas locales)*
     - `https://TU_USUARIO.github.io` *(tu GitHub Pages cuando lo despliegues)*
   - **NO** agregues URIs de redirección (no las usamos).
   - Crear.
5. Copia el **Client ID** (termina en `.apps.googleusercontent.com`). Lo usarás en el Paso 4.

---

## Paso 4 — Configurar el frontend (1 min)

Edita el archivo [`config.js`](config.js) y reemplaza los dos valores:

```js
window.CONFIG = {
  backendUrl: "https://script.google.com/macros/s/AKfyc.../exec",
  googleClientId: "123456789-abc.apps.googleusercontent.com"
};
```

---

## Paso 5 — Probar localmente (2 min)

Desde la carpeta del proyecto:

```bash
# Python 3 (preinstalado en Mac/Linux)
python3 -m http.server 8000

# o con Node si lo tienes:
npx serve -p 8000
```

Abre <http://localhost:8000>. Inicia sesión con tu Google → deberías ver los grupos del Mundial.

**Probar el escaneo:** abre cualquier equipo → "📷 Escanear foto" → sube una foto de una página del álbum.

---

## Paso 6 — Desplegar a GitHub Pages (5 min)

1. Crea un repo nuevo en GitHub: `familia-green-bay` (público).
2. Desde la carpeta del proyecto:

   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/TU_USUARIO/familia-green-bay.git
   git push -u origin main
   ```

3. En GitHub → repo → **Settings** → **Pages**:
   - **Source:** *Deploy from a branch*.
   - **Branch:** `main` / `(root)` → Save.
4. Espera 1-2 min. Tu app estará en:
   ```
   https://TU_USUARIO.github.io/familia-green-bay/
   ```

5. **Vuelve al Paso 3.4** y agrega esa URL a los "Orígenes JavaScript autorizados" en Google Cloud Console (sin esta acción, el login fallará en producción).

---

## ⚠️ Consideraciones de seguridad

- **NUNCA** subas a GitHub el archivo `config.js` con la URL real del backend si el repo es público y quieres limitar quién usa tu API key.
  - El `googleClientId` es público por diseño.
  - La `backendUrl` también es pública, pero el backend rechaza requests sin un `idToken` válido de Google.
  - La protección real está en `ALLOWED_EMAILS` (Paso 2.2): solo los emails que listes pueden usar la app.
- Tu `ANTHROPIC_API_KEY` nunca sale del servidor de Apps Script.

---

## 🛠 Troubleshooting

| Síntoma | Causa probable / Solución |
|---|---|
| `Backend HTTP 0` o CORS error | Revisa que la URL de Apps Script termine en `/exec`, no `/dev`. Re-despliega si cambia. |
| `Unauthorized` al iniciar sesión | Email no está en `ALLOWED_EMAILS`, o el token expiró (recarga la página). |
| El botón de Google no aparece | Falta el `googleClientId` en config.js, o tu URL no está en "Orígenes JavaScript autorizados" en Google Cloud. |
| Claude API error 401 | `ANTHROPIC_API_KEY` mal copiada en Script Properties. |
| El escaneo detecta mal las fichas | Toma la foto con buena luz, centrada, sin reflejos. Usa Claude Sonnet en vez de Haiku editando `ANTHROPIC_MODEL` en `Code.gs` (más caro, más preciso). |
| `cannot read property 'getEmail'` | Ejecuta `setupSheet()` desde el editor para autorizar permisos. |

---

## ✏️ Personalizar el álbum

Cuando salga el listado oficial Panini del Mundial 2026 o cuando sepas el conteo real de fichas por página, edita [`data/album-structure.json`](data/album-structure.json):

- `stickerCount` por equipo o sección → ajusta al número real de slots.
- Reasigna equipos a grupos si difieren del sorteo final.
- Agrega/quita secciones especiales según tu álbum.

Sube los cambios a GitHub y se reflejan al instante (`git push`).

---

## 💰 Costos estimados

| Concepto | Costo |
|---|---|
| GitHub Pages | Gratis |
| Google Apps Script | Gratis (cuotas: 20K llamadas/día) |
| Google Sheets | Gratis |
| Google OAuth | Gratis |
| Claude Haiku 4.5 (escaneo) | ~$0.001-0.003 por foto → $1-3 por escanear el álbum completo (48 equipos + secciones) |

---

## 👨‍👩‍👧 Multi-usuario

Cada familiar inicia sesión con su Google y ve **su propio inventario** (separado por email en el Sheet). Si quieren compartir un inventario, todos usan el mismo email.

Para ver el inventario de todos en el Sheet:
- Columna `email` distingue al usuario
- Puedes filtrar con `=FILTER(Inventory!A:E, Inventory!A:A="email@familiar")` en otra hoja.
