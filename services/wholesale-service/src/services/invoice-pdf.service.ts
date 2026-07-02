import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';

const FONT_DIR = path.join(__dirname, '..', '..', 'fonts');
const FONT_REGULAR = path.join(FONT_DIR, 'DejaVuSans.ttf');
const FONT_BOLD = path.join(FONT_DIR, 'DejaVuSans-Bold.ttf');

function money(n: any): string {
  const v = parseFloat(n) || 0;
  return v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function qty(n: any): string {
  const v = parseFloat(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toLocaleString('ru-RU', { maximumFractionDigits: 3 });
}

/**
 * Генерация PDF-накладной по оптовому заказу (расходная накладная).
 * Возвращает Buffer с готовым PDF.
 */
export function generateInvoicePdf(order: any, seller?: { name?: string; legalName?: string; taxId?: string; address?: string; phone?: string }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const hasFonts = fs.existsSync(FONT_REGULAR) && fs.existsSync(FONT_BOLD);
      if (hasFonts) {
        doc.registerFont('R', FONT_REGULAR);
        doc.registerFont('B', FONT_BOLD);
      }
      const R = hasFonts ? 'R' : 'Helvetica';
      const B = hasFonts ? 'B' : 'Helvetica-Bold';

      const date = order.shipped_at || order.confirmed_at || order.created_at;
      const dateStr = date ? new Date(date).toLocaleDateString('ru-RU') : '';

      // Шапка
      doc.font(B).fontSize(16).text(`РАСХОДНАЯ НАКЛАДНАЯ ${order.invoice_number || ''}`, { align: 'center' });
      doc.font(R).fontSize(10).text(`от ${dateStr}`, { align: 'center' });
      doc.moveDown(1.2);

      // Стороны
      const sellerName = seller?.legalName || seller?.name || 'Поставщик';
      doc.font(B).fontSize(10).text('Поставщик: ', { continued: true }).font(R)
        .text(`${sellerName}${seller?.taxId ? `, ИНН ${seller.taxId}` : ''}${seller?.address ? `, ${seller.address}` : ''}${seller?.phone ? `, тел. ${seller.phone}` : ''}`);
      doc.moveDown(0.3);
      const buyer = order.counterparty_legal_name || order.counterparty_name || '';
      doc.font(B).text('Покупатель: ', { continued: true }).font(R)
        .text(`${buyer}${order.counterparty_tax_id ? `, ИНН ${order.counterparty_tax_id}` : ''}${order.counterparty_phone ? `, тел. ${order.counterparty_phone}` : ''}`);
      if (order.delivery_address) {
        doc.moveDown(0.3);
        doc.font(B).text('Адрес доставки: ', { continued: true }).font(R).text(order.delivery_address);
      }
      doc.moveDown(1);

      // Таблица позиций
      const tableTop = doc.y;
      const cols = [
        { key: 'idx', title: '№', x: 40, w: 28, align: 'left' as const },
        { key: 'name', title: 'Наименование', x: 68, w: 218, align: 'left' as const },
        { key: 'qty', title: 'Кол-во', x: 286, w: 52, align: 'right' as const },
        { key: 'unit', title: 'Ед.', x: 348, w: 38, align: 'left' as const },
        { key: 'price', title: 'Цена, ₽', x: 386, w: 80, align: 'right' as const },
        { key: 'total', title: 'Сумма, ₽', x: 466, w: 90, align: 'right' as const }
      ];

      doc.font(B).fontSize(9);
      cols.forEach(c => doc.text(c.title, c.x, tableTop, { width: c.w, align: c.align }));
      doc.moveTo(40, tableTop + 14).lineTo(556, tableTop + 14).stroke();

      doc.font(R).fontSize(9);
      let y = tableTop + 20;
      const items = order.items || [];
      items.forEach((item: any, i: number) => {
        const q = item.shipped_quantity ?? item.quantity;
        const rowH = Math.max(
          doc.heightOfString(item.name, { width: cols[1].w }),
          12
        ) + 6;
        if (y + rowH > doc.page.height - 120) {
          doc.addPage();
          y = 40;
        }
        doc.text(String(i + 1), cols[0].x, y, { width: cols[0].w });
        doc.text(item.name, cols[1].x, y, { width: cols[1].w });
        doc.text(qty(q), cols[2].x, y, { width: cols[2].w, align: 'right' });
        doc.text(item.unit || item.item_unit || '', cols[3].x, y, { width: cols[3].w });
        doc.text(money(item.price), cols[4].x, y, { width: cols[4].w, align: 'right' });
        doc.text(money(item.total), cols[5].x, y, { width: cols[5].w, align: 'right' });
        y += rowH;
      });

      doc.moveTo(40, y).lineTo(556, y).stroke();
      y += 10;

      // Итоги
      doc.font(B).fontSize(11);
      doc.text(`Итого: ${money(order.total_amount)} ₽`, 286, y, { width: 270, align: 'right' });
      y += 18;
      if (parseFloat(order.paid_amount) > 0) {
        doc.font(R).fontSize(10);
        doc.text(`Оплачено: ${money(order.paid_amount)} ₽`, 286, y, { width: 270, align: 'right' });
        y += 14;
        const debt = (parseFloat(order.total_amount) || 0) - (parseFloat(order.paid_amount) || 0);
        if (debt > 0.005) {
          doc.text(`К оплате: ${money(debt)} ₽`, 286, y, { width: 270, align: 'right' });
          y += 14;
        }
      }
      y += 20;

      // Подписи
      doc.font(R).fontSize(10);
      doc.text('Отпустил: _________________', 40, y);
      doc.text('Получил: _________________', 320, y);
      y += 24;
      const manager = [order.manager_first_name, order.manager_last_name].filter(Boolean).join(' ');
      const driver = [order.driver_first_name, order.driver_last_name].filter(Boolean).join(' ');
      doc.fontSize(8).fillColor('#666666');
      if (manager) doc.text(`Менеджер: ${manager}`, 40, y);
      if (driver) doc.text(`Водитель: ${driver}`, 320, y);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

export function invoiceFileName(order: any): string {
  const num = (order.invoice_number || order.id).replace(/[^\wа-яА-ЯёЁ-]+/g, '_');
  const client = (order.counterparty_name || '').replace(/[^\wа-яА-ЯёЁ-]+/g, '_').slice(0, 30);
  const d = new Date(order.shipped_at || order.created_at || Date.now()).toISOString().slice(0, 10);
  return `Накладная_${num}_${client}_${d}.pdf`;
}
