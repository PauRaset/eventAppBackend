// utils/buildTicketPdf.js
const PDFDocument = require('pdfkit');

function buildTicketPdf({
  eventTitle,
  clubName,
  eventDate,
  venue,

  // legacy (1 ticket)
  serial,
  qrPngBuffer,
  seatLabel,

  // nuevo (N tickets) => 1 página por entrada
  tickets,

  buyerName,
  ticketTheme,
  // Logo opcional (para branding por cuenta)
  brandLogoPath,
  brandLogoPngBuffer,
}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 48 });
      const bufs = [];

      // Temas (estética) para entradas. Mantiene "default" idéntico a lo actual.
      const THEMES = {
        default: {
          bg: '#0b0f19',
          card: '#0d1220',
          stroke: '#1e293b',
          text: '#e5e7eb',
          muted: '#93a4bf',
          accent: '#00e5ff',
          headerStroke: '#082032',
          innerStroke: '#053a44',
          title: '#f1f5f9',
          sub: '#cbd5e1',
          venue: '#9fb0c9',
          logoPath: '',
          logoBg: '#ffffff',
        },
        clubX: {
          // Estética CLUB: fondo blanco + acento rojo (logo rojo)
          bg: '#ffffff',
          card: '#ffffff',
          stroke: '#e5e7eb',
          text: '#111827',
          muted: '#6b7280',
          accent: '#C70000',
          headerStroke: '#C70000',
          innerStroke: '#f3f4f6',
          title: '#111827',
          sub: '#374151',
          venue: '#4b5563',
          // Ruta opcional al logo para este tema (mejor en PNG transparente)
          logoPath: (process.env.CLUBX_TICKET_LOGO_PATH || '').trim(),
          logoBg: '#ffffff',
        },
        primeraEvents: {
          // Estética CLUB: fondo blanco + acento rojo (logo rojo)
          bg: '#ffffff',
          card: '#ffffff',
          stroke: '#e5e7eb',
          text: '#111827',
          muted: '#6b7280',
          accent: '#C70000',
          headerStroke: '#C70000',
          innerStroke: '#f3f4f6',
          title: '#111827',
          sub: '#374151',
          venue: '#4b5563',
          // Ruta opcional al logo para este tema (mejor en PNG transparente)
          logoPath: (process.env.PRIMERA_TICKET_LOGO_PATH || '').trim(),
          logoBg: '#ffffff',
        },
      };

      const themeName = (typeof ticketTheme === 'string' && ticketTheme.trim()) ? ticketTheme.trim() : 'default';
      const T = THEMES[themeName] || THEMES.default;

      const COLOR_BG = T.bg;           // fondo general
      const COLOR_CARD = T.card;       // tarjeta
      const COLOR_STROKE = T.stroke;   // bordes
      const COLOR_TEXT = T.text;       // texto base
      const COLOR_MUTED = T.muted;     // texto suave
      const COLOR_ACCENT = T.accent;   // acento

      doc.on('data', (d) => bufs.push(d));
      doc.on('end', () => resolve(Buffer.concat(bufs)));

      // Normalizar tickets (retrocompatible)
      let normalizedTickets = Array.isArray(tickets) ? tickets.filter(Boolean) : [];
      if (normalizedTickets.length === 0) {
        normalizedTickets = [{ serial, qrPngBuffer, seatLabel }];
      }
      normalizedTickets = normalizedTickets.filter((t) => t && t.serial && t.qrPngBuffer);
      if (normalizedTickets.length === 0) {
        throw new Error('[buildTicketPdf] Falta tickets válidos (serial + qrPngBuffer)');
      }
      const totalTickets = normalizedTickets.length;

      const renderTicketPage = (t, index) => {
        const pageSerial = t.serial;
        const pageQrPngBuffer = t.qrPngBuffer;
        const pageSeatLabel = t.seatLabel || '';

        // Fondo
        doc.rect(0, 0, doc.page.width, doc.page.height).fill(COLOR_BG);

        // Tarjeta principal
        const cardX = 36;
        const cardY = 36;
        const cardW = doc.page.width - 72;
        const cardH = doc.page.height - 72;

        // Glow exterior (marco doble sutil)
        doc.save()
          .roundedRect(cardX - 2, cardY - 2, cardW + 4, cardH + 4, 16)
          .lineWidth(1)
          .strokeColor(T.headerStroke)
          .stroke()
          .restore();

        // Tarjeta con borde
        doc.save()
          .roundedRect(cardX, cardY, cardW, cardH, 14)
          .lineWidth(1.6)
          .fillAndStroke(COLOR_CARD, COLOR_STROKE)
          .restore();

        // Bordes interiores con acento muy fino
        doc.save()
          .roundedRect(cardX + 1.5, cardY + 1.5, cardW - 3, cardH - 3, 12)
          .lineWidth(0.6)
          .strokeColor(T.innerStroke)
          .stroke()
          .restore();

        // Encabezado
        const headerY = cardY + 18;
        const headerLabel = (themeName === 'clubX' || themeName === 'primeraEvents')
          ? 'ENTRADA'
          : 'NIGHTVIBE — DIGITAL TICKET';

        const pageSuffix = totalTickets > 1 ? ` • ENTRADA ${index + 1}/${totalTickets}` : '';
        doc.fillColor(COLOR_MUTED).fontSize(10).text(headerLabel + pageSuffix, cardX + 22, headerY);

        // Logo de marca (por tema) — opcional
        // Prioridad: buffer > path pasado por parámetro > path del tema
        const logoInput = brandLogoPngBuffer || brandLogoPath || T.logoPath;
        if (logoInput) {
          try {
            const logoMaxW = 160;
            const logoMaxH = 50;
            const logoX = cardX + cardW - 22 - logoMaxW;
            const logoY = headerY - 10;

            // Fondo suave (para que el logo se lea bien en modo oscuro)
            doc.save();
            doc.roundedRect(logoX - 8, logoY - 6, logoMaxW + 16, logoMaxH + 12, 10)
              .fillOpacity(0.10)
              .fill(T.logoBg || '#ffffff')
              .restore();

            doc.image(logoInput, logoX, logoY, { fit: [logoMaxW, logoMaxH], align: 'right', valign: 'center' });
          } catch (_) {
            // si falla el logo, no rompemos el PDF
          }
        }

        // Club pill
        if (clubName) {
          const pillX = cardX + 22;
          const pillY = headerY + 18;
          const pillH = 22;
          const pillPad = 12;
          const pillText = String(clubName).toUpperCase();
          const pillW = doc.widthOfString(pillText) + pillPad * 2;
          doc.save()
            .roundedRect(pillX, pillY, pillW, pillH, 11)
            .fillOpacity(0.12)
            .fill(COLOR_ACCENT)
            .restore();
          doc.fillColor(COLOR_ACCENT).fontSize(11).text(pillText, pillX + pillPad, pillY + 5, { width: pillW - pillPad * 2, align: 'left' });
        }

        // Evento — tipografía grande
        const titleY = headerY + (clubName ? 50 : 30);
        doc.fillColor(T.title).fontSize(28).text(eventTitle || 'Evento', cardX + 22, titleY, { width: cardW - 44 });

        // Subinfo (fecha + venue)
        let subY = titleY + 34;
        if (eventDate) {
          doc.fillColor(T.sub).fontSize(12).text(eventDate, cardX + 22, subY, { width: cardW - 44 });
          subY += 16;
        }
        if (venue) {
          doc.fillColor(T.venue).fontSize(12).text(venue, cardX + 22, subY, { width: cardW - 44 });
          subY += 12;
        }

        // Línea divisoria
        const sepY = (cardY + 110);
        doc.moveTo(cardX + 14, sepY).lineTo(cardX + cardW - 14, sepY).lineWidth(1).stroke(COLOR_STROKE);

        // Bloque datos + QR
        const leftX = cardX + 22;

        // --- QR centrado (horizontal + vertical) dentro de la tarjeta ---
        const qrSize = 220;
        const qrLabelH = 18; // espacio para el texto "SCAN ME"
        const qrBlockH = qrSize + qrLabelH;

        // Área de contenido: desde debajo del separador hasta antes del footer
        const contentTop = sepY + 24;
        const contentBottom = cardY + cardH - 110;

        const qrX = cardX + (cardW - qrSize) / 2;
        const qrY = contentTop + Math.max(0, ((contentBottom - contentTop) - qrBlockH) / 2);

        // Datos debajo del QR (evita solapamientos y mantiene el diseño limpio)
        const topY = qrY + qrBlockH + 18;

        // Datos
        doc.fillColor(COLOR_TEXT).fontSize(12);
        const lineH = 18;
        let y = topY;

        if (buyerName) {
          doc.text('Comprador', leftX, y);
          doc.fillColor(T.sub).text(buyerName, leftX + 100, y);
          y += lineH;
          doc.fillColor(COLOR_TEXT);
        }

        if (pageSeatLabel) {
          doc.text('Entrada', leftX, y);
          doc.fillColor(T.sub).text(pageSeatLabel, leftX + 100, y);
          y += lineH;
          doc.fillColor(COLOR_TEXT);
        }

        doc.text('Serial', leftX, y);
        doc.fillColor(T.sub).text(pageSerial || '—', leftX + 100, y);
        y += lineH;

        doc.fillColor(COLOR_MUTED).fontSize(10)
          .text('Muestra este QR en la entrada. La reventa o alteración invalida la entrada.', leftX, y + 6, { width: cardW - 44 });

        // QR (posición ya calculada arriba para centrarlo)
        try {
          doc.save();
          // Marco doble
          doc.roundedRect(qrX - 10, qrY - 10, qrSize + 20, qrSize + 20, 12).lineWidth(1).stroke(COLOR_STROKE);
          doc.roundedRect(qrX - 6, qrY - 6, qrSize + 12, qrSize + 12, 10).lineWidth(1).stroke(COLOR_ACCENT);
          doc.image(pageQrPngBuffer, qrX, qrY, { width: qrSize, height: qrSize });
          doc.restore();
          doc.fillColor(COLOR_MUTED).fontSize(9).text('SCAN ME', qrX, qrY + qrSize + 8, { width: qrSize, align: 'center' });
        } catch (_) {
          // omit QR if fails
        }

        // Footer
        const footerY = cardY + cardH - 40;
        doc.moveTo(cardX + 14, footerY - 10).lineTo(cardX + cardW - 14, footerY - 10).lineWidth(0.6).stroke(COLOR_STROKE);
        doc.fillColor(COLOR_MUTED).fontSize(9);
        doc.text('NightVibe • nightvibe.life', cardX + 22, footerY);
        doc.fillColor(COLOR_ACCENT).text(`Ticket: ${pageSerial || '—'}`, cardX + cardW - 200, footerY, { width: 180, align: 'right' });
      };

      // Render: 1 página por ticket
      normalizedTickets.forEach((t, i) => {
        if (i > 0) {
          doc.addPage({ size: 'A4', margin: 48 });
        }
        renderTicketPage(t, i);
      });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildTicketPdf };


/*// utils/buildTicketPdf.js
const PDFDocument = require('pdfkit');

function buildTicketPdf({
  eventTitle,
  clubName,
  eventDate,
  venue,
  serial,
  qrPngBuffer,
  buyerName,
  seatLabel,
  ticketTheme,
  // Logo opcional (para branding por cuenta)
  brandLogoPath,
  brandLogoPngBuffer,
}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 48 });
      const bufs = [];

      // Temas (estética) para entradas. Mantiene "default" idéntico a lo actual.
      const THEMES = {
        default: {
          bg: '#0b0f19',
          card: '#0d1220',
          stroke: '#1e293b',
          text: '#e5e7eb',
          muted: '#93a4bf',
          accent: '#00e5ff',
          headerStroke: '#082032',
          innerStroke: '#053a44',
          title: '#f1f5f9',
          sub: '#cbd5e1',
          venue: '#9fb0c9',
          logoPath: '',
          logoBg: '#ffffff',
        },
        clubX: {
          // Estética CLUB: fondo blanco + acento rojo (logo rojo)
          bg: '#ffffff',
          card: '#ffffff',
          stroke: '#e5e7eb',
          text: '#111827',
          muted: '#6b7280',
          accent: '#C70000',
          headerStroke: '#C70000',
          innerStroke: '#f3f4f6',
          title: '#111827',
          sub: '#374151',
          venue: '#4b5563',
          // Ruta opcional al logo para este tema (mejor en PNG transparente)
          logoPath: (process.env.CLUBX_TICKET_LOGO_PATH || '').trim(),
          logoBg: '#ffffff',
        },
        primeraEvents: {
          // Estética CLUB: fondo blanco + acento rojo (logo rojo)
          bg: '#ffffff',
          card: '#ffffff',
          stroke: '#e5e7eb',
          text: '#111827',
          muted: '#6b7280',
          accent: '#C70000',
          headerStroke: '#C70000',
          innerStroke: '#f3f4f6',
          title: '#111827',
          sub: '#374151',
          venue: '#4b5563',
          // Ruta opcional al logo para este tema (mejor en PNG transparente)
          logoPath: (process.env.PRIMERA_TICKET_LOGO_PATH || '').trim(),
          logoBg: '#ffffff',
        },
      };

      const themeName = (typeof ticketTheme === 'string' && ticketTheme.trim()) ? ticketTheme.trim() : 'default';
      const T = THEMES[themeName] || THEMES.default;

      const COLOR_BG = T.bg;           // fondo general
      const COLOR_CARD = T.card;       // tarjeta
      const COLOR_STROKE = T.stroke;   // bordes
      const COLOR_TEXT = T.text;       // texto base
      const COLOR_MUTED = T.muted;     // texto suave
      const COLOR_ACCENT = T.accent;   // acento

      doc.on('data', (d) => bufs.push(d));
      doc.on('end', () => resolve(Buffer.concat(bufs)));

      // Fondo
      doc.rect(0, 0, doc.page.width, doc.page.height).fill(COLOR_BG);

      // Tarjeta principal
      const cardX = 36;
      const cardY = 36;
      const cardW = doc.page.width - 72;
      const cardH = doc.page.height - 72;

      // Glow exterior (marco doble sutil)
      doc.save()
        .roundedRect(cardX - 2, cardY - 2, cardW + 4, cardH + 4, 16)
        .lineWidth(1)
        .strokeColor(T.headerStroke)
        .stroke()
        .restore();

      // Tarjeta con borde
      doc.save()
        .roundedRect(cardX, cardY, cardW, cardH, 14)
        .lineWidth(1.6)
        .fillAndStroke(COLOR_CARD, COLOR_STROKE)
        .restore();

      // Bordes interiores con acento muy fino
      doc.save()
        .roundedRect(cardX + 1.5, cardY + 1.5, cardW - 3, cardH - 3, 12)
        .lineWidth(0.6)
        .strokeColor(T.innerStroke)
        .stroke()
        .restore();

      // Encabezado
      const headerY = cardY + 18;
      const headerLabel = themeName === 'clubX'
        ? 'COMISSIÓ DE FESTES — ENTRADA'
        : 'NIGHTVIBE — DIGITAL TICKET';
      doc.fillColor(COLOR_MUTED).fontSize(10).text(headerLabel, cardX + 22, headerY);

      // Logo de marca (por tema) — opcional
      // Prioridad: buffer > path pasado por parámetro > path del tema
      const logoInput = brandLogoPngBuffer || brandLogoPath || T.logoPath;
      if (logoInput) {
        try {
          const logoMaxW = 160;
          const logoMaxH = 50;
          const logoX = cardX + cardW - 22 - logoMaxW;
          const logoY = headerY - 10;

          // Fondo suave (para que el logo se lea bien en modo oscuro)
          doc.save();
          doc.roundedRect(logoX - 8, logoY - 6, logoMaxW + 16, logoMaxH + 12, 10)
            .fillOpacity(0.10)
            .fill(T.logoBg || '#ffffff')
            .restore();

          doc.image(logoInput, logoX, logoY, { fit: [logoMaxW, logoMaxH], align: 'right', valign: 'center' });
        } catch (_) {
          // si falla el logo, no rompemos el PDF
        }
      }

      // Club pill
      if (clubName) {
        const pillX = cardX + 22;
        const pillY = headerY + 18;
        const pillH = 22;
        const pillPad = 12;
        const pillText = String(clubName).toUpperCase();
        const pillW = doc.widthOfString(pillText) + pillPad * 2;
        doc.save()
          .roundedRect(pillX, pillY, pillW, pillH, 11)
          .fillOpacity(0.12)
          .fill(COLOR_ACCENT)
          .restore();
        doc.fillColor(COLOR_ACCENT).fontSize(11).text(pillText, pillX + pillPad, pillY + 5, { width: pillW - pillPad * 2, align: 'left' });
      }

      // Evento — tipografía grande
      const titleY = headerY + (clubName ? 50 : 30);
      doc.fillColor(T.title).fontSize(28).text(eventTitle || 'Evento', cardX + 22, titleY, { width: cardW - 44 });

      // Subinfo (fecha + venue)
      let subY = titleY + 34;
      if (eventDate) {
        doc.fillColor(T.sub).fontSize(12).text(eventDate, cardX + 22, subY, { width: cardW - 44 });
        subY += 16;
      }
      if (venue) {
        doc.fillColor(T.venue).fontSize(12).text(venue, cardX + 22, subY, { width: cardW - 44 });
        subY += 12;
      }

      // Línea divisoria
      const sepY = (cardY + 110);
      doc.moveTo(cardX + 14, sepY).lineTo(cardX + cardW - 14, sepY).lineWidth(1).stroke(COLOR_STROKE);

      // Bloque datos + QR
      const leftX = cardX + 22;

      // --- QR centrado (horizontal + vertical) dentro de la tarjeta ---
      const qrSize = 220;
      const qrLabelH = 18; // espacio para el texto "SCAN ME"
      const qrBlockH = qrSize + qrLabelH;

      // Área de contenido: desde debajo del separador hasta antes del footer
      const contentTop = sepY + 24;
      const contentBottom = cardY + cardH - 110;

      const qrX = cardX + (cardW - qrSize) / 2;
      const qrY = contentTop + Math.max(0, ((contentBottom - contentTop) - qrBlockH) / 2);

      // Datos debajo del QR (evita solapamientos y mantiene el diseño limpio)
      const topY = qrY + qrBlockH + 18;

      // Datos
      doc.fillColor(COLOR_TEXT).fontSize(12);
      const lineH = 18;
      let y = topY;

      if (buyerName) {
        doc.text('Comprador', leftX, y);
        doc.fillColor(T.sub).text(buyerName, leftX + 100, y);
        y += lineH;
        doc.fillColor(COLOR_TEXT);
      }

      if (seatLabel) {
        doc.text('Entrada', leftX, y);
        doc.fillColor(T.sub).text(seatLabel, leftX + 100, y);
        y += lineH;
        doc.fillColor(COLOR_TEXT);
      }

      doc.text('Serial', leftX, y);
      doc.fillColor(T.sub).text(serial || '—', leftX + 100, y);
      y += lineH;

      doc.fillColor(COLOR_MUTED).fontSize(10)
        .text('Muestra este QR en la entrada. La reventa o alteración invalida la entrada.', leftX, y + 6, { width: cardW - 44 });

      // QR (posición ya calculada arriba para centrarlo)

      try {
        doc.save();
        // Marco doble
        doc.roundedRect(qrX - 10, qrY - 10, qrSize + 20, qrSize + 20, 12).lineWidth(1).stroke(COLOR_STROKE);
        doc.roundedRect(qrX - 6, qrY - 6, qrSize + 12, qrSize + 12, 10).lineWidth(1).stroke(COLOR_ACCENT);
        doc.image(qrPngBuffer, qrX, qrY, { width: qrSize, height: qrSize });
        doc.restore();
        doc.fillColor(COLOR_MUTED).fontSize(9).text('SCAN ME', qrX, qrY + qrSize + 8, { width: qrSize, align: 'center' });
      } catch (_) {
        // omit QR if fails
      }

      // Footer
      const footerY = cardY + cardH - 40;
      doc.moveTo(cardX + 14, footerY - 10).lineTo(cardX + cardW - 14, footerY - 10).lineWidth(0.6).stroke(COLOR_STROKE);
      doc.fillColor(COLOR_MUTED).fontSize(9);
      doc.text('NightVibe • nightvibe.life', cardX + 22, footerY);
      doc.fillColor(COLOR_ACCENT).text(`Ticket: ${serial || '—'}`, cardX + cardW - 200, footerY, { width: 180, align: 'right' });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildTicketPdf };*/
