const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const cron = require('node-cron');
const fetch = require('node-fetch');
const qrcode = require('qrcode-terminal');
const express = require('express');

// ── Configuración ────────────────────────────────────────────────────
const CRM_URL      = process.env.CRM_URL;       // ej: https://tudominio.com/crm_sync.php?k=MAQ2024
const CRM_BASE_URL = process.env.CRM_BASE_URL;  // ej: https://tudominio.com/index.html
const SEND_HOUR    = process.env.SEND_HOUR || '30 8'; // minuto hora (8:30 por defecto)

// ── Keep-alive HTTP (necesario para Render.com) ──────────────────────
const app = express();
app.get('/', (_, res) => res.send('Bot activo ✓'));
app.listen(process.env.PORT || 3000);

// ── Cliente WhatsApp ─────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  }
});

client.on('qr', qr => {
  console.log('\n═══════════════════════════════════════');
  console.log('  Escanea este QR con WhatsApp:');
  console.log('═══════════════════════════════════════\n');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => console.log('✓ Sesión autenticada'));
client.on('auth_failure', () => console.log('✗ Error de autenticación — borra carpeta .wwebjs_auth y reinicia'));

client.on('ready', () => {
  console.log('✓ Bot conectado y listo');
  // Programar envío diario (zona horaria España)
  cron.schedule(`${SEND_HOUR} * * *`, sendDailyReminders, { timezone: 'Europe/Madrid' });
  console.log(`✓ Recordatorios programados a las ${SEND_HOUR.split(' ').reverse().join(':')} h`);
});

// ── Lógica principal ─────────────────────────────────────────────────
async function sendDailyReminders() {
  console.log(`[${new Date().toLocaleString('es-ES')}] Enviando recordatorios...`);

  let data;
  try {
    const res = await fetch(CRM_URL);
    data = await res.json();
  } catch (e) {
    console.error('Error leyendo CRM:', e.message);
    return;
  }

  const users     = data.users     || [];
  const proyectos = data.proyectos || [];
  const today     = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  for (const user of users) {
    if (!user.tel) continue; // sin teléfono → saltamos

    // Proyectos del día: asignados al usuario, activos, y hoy está dentro del rango fecha-fechaFin
    const misProyectos = proyectos.filter(p => {
      const asignado = (p.responsables || []).some(id => String(id) === String(user.id));
      const noFinalizado = p.estado !== 'finalizado';
      const fechaInicio = p.fecha || '';
      const fechaFin    = p.fechaFin || p.fecha || '';
      const hoyEnRango  = today >= fechaInicio && today <= fechaFin;
      return asignado && noFinalizado && hoyEnRango;
    });

    if (!misProyectos.length) continue; // sin proyectos hoy → no mandamos nada

    // Formatear número: asegurar prefijo +34
    const digits = user.tel.replace(/\D/g, '');
    const phone  = digits.startsWith('34') ? digits : `34${digits}`;
    const chatId = `${phone}@c.us`;

    // Construir mensaje de texto
    let msg = `🔧 *Buenos días ${user.nombre || 'equipo'}!*\n`;
    msg += `Aquí tienes tus proyectos para hoy *${formatDate(today)}*:\n\n`;

    for (const p of misProyectos) {
      msg += `📋 *${p.nombre || 'Sin nombre'}*\n`;
      if (p.estado)       msg += `• Estado: ${capitalizar(p.estado)}\n`;
      if (p.descripcion)  msg += `• ${p.descripcion}\n`;
      if (p.fechaFin && p.fechaFin !== p.fecha) msg += `• Entrega: ${formatDate(p.fechaFin)}\n`;
      if (CRM_BASE_URL)   msg += `• 🔗 ${CRM_BASE_URL}#proyecto_${p.id}\n`;
      msg += '\n';
    }

    msg += `_Maquinando S.L. · ${new Date().getFullYear()}_`;

    try {
      await client.sendMessage(chatId, msg);
      console.log(`  ✓ Mensaje enviado a ${user.nombre} (${phone})`);
    } catch (e) {
      console.error(`  ✗ Error enviando a ${user.nombre}:`, e.message);
      continue;
    }

    // Enviar imágenes y adjuntos de cada proyecto (máx 5 archivos en total)
    let filesSent = 0;
    for (const p of misProyectos) {
      if (filesSent >= 5) break;
      const adjuntos = [...(p.imgs || []), ...(p.adjuntos || []), ...(p.fotos || [])];
      for (const adj of adjuntos) {
        if (filesSent >= 5) break;
        if (!adj || !adj.d || !adj.d.startsWith('data:')) continue;
        try {
          const [header, b64] = adj.d.split(',');
          const mime = (header.match(/:(.*?);/) || ['', 'application/octet-stream'])[1];
          const media = new MessageMedia(mime, b64, adj.n || 'archivo');
          await client.sendMessage(chatId, media, { caption: `📎 ${adj.n || 'Adjunto'} — ${p.nombre}` });
          filesSent++;
        } catch (e) {
          console.log(`  ⚠ No se pudo enviar adjunto: ${e.message}`);
        }
      }
    }
  }

  console.log(`[${new Date().toLocaleString('es-ES')}] Recordatorios completados`);
}

// ── Utilidades ───────────────────────────────────────────────────────
function formatDate(iso) {
  if (!iso) return '-';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
function capitalizar(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

// ── Arrancar ─────────────────────────────────────────────────────────
client.initialize();
