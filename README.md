# Familia Green Bay ⚽

Inventario del álbum **Panini FIFA World Cup 2026**. Sube una foto de cada página y la app detecta automáticamente qué fichas tienes y cuáles te faltan.

## Características

- 🏆 **48 equipos** organizados en los 12 grupos del Mundial (A-L).
- ⭐ Secciones especiales: mascotas, ciudades sede, estadios, Coca-Cola, museo FIFA, leyendas, etc.
- 📷 **Escaneo automático con IA**: foto → Claude Vision detecta qué espacios están rellenos.
- ✋ Marcado manual: click para tener, click otra vez para repetidas (×2, ×3…).
- 👨‍👩‍👧 Multi-usuario familiar: cada quien con su login de Google y su inventario.
- 📊 Stats globales: tienes, faltan, repetidas, % completado.
- 🔍 Vista "Solo faltantes" — lista lista para imprimir / mandar por WhatsApp.
- ☁️ Datos en Google Sheets — backup automático, exportable.

## Demo local rápida

```bash
python3 -m http.server 8000
# Abre http://localhost:8000
```

(Necesita configuración previa, ver abajo.)

## Setup

👉 **Lee [SETUP.md](SETUP.md)** — guía paso a paso (30 min la primera vez).

Resumen:
1. Crear Google Sheet
2. Configurar Google Apps Script (backend) + API key de Claude
3. Crear Google OAuth Client ID
4. Editar `config.js` con las 2 URLs
5. `git push` a GitHub Pages

## Estructura

```
.
├── index.html                  # UI
├── styles.css                  # Estilos (paleta verde Green Bay + dorado)
├── app.js                      # Lógica frontend
├── config.js                   # ⚠️ Tus URLs (no commitear si repo público)
├── data/
│   └── album-structure.json    # 48 equipos + 12 grupos + secciones especiales
├── apps-script/
│   └── Code.gs                 # Backend: auth, Sheets, Claude Vision proxy
├── SETUP.md                    # Guía de instalación
└── README.md
```

## Tecnologías

- **Frontend:** HTML/CSS/JS vanilla, sin build, sin dependencias. Funciona en GitHub Pages.
- **Backend:** Google Apps Script (web app gratuito).
- **Auth:** Google Identity Services (ID tokens verificados server-side).
- **Vision:** Claude Haiku 4.5 vía Anthropic API.
- **Storage:** Google Sheets.

## Costo

Todo gratis excepto las llamadas a Claude (~$0.002 por foto escaneada).
